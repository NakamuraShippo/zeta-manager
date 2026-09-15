/**
 * 要約実行エンジン (§28-§30)。
 * - 長文は MessageRecord 単位のチャンクへ分割して Map-Reduce 要約する
 * - 中間要約も時系列を維持する
 * - 最終出力が目標文字数を大きく超えた場合は最大 2 回再圧縮する
 */

import { MESSAGE_SEPARATOR } from "../shared/text-format";
import { countChars, substitutePlaceholders } from "../shared/utils";
import type { LlmProvider } from "./provider";

export interface SummarizeJobOptions {
  targetChars: number;
  /** {{targetChars}} を含む指示テンプレート（ユーザー設定） */
  instructionTemplate: string;
  model: string;
  temperature: number;
  maxInputCharsPerRequest: number;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

export interface SummarizeJobResult {
  text: string;
  chars: number;
  chunkCount: number;
  recompressCount: number;
}

/** 目標文字数の許容範囲 (§30): 0.85N ～ 1.10N */
export const TARGET_MIN_RATIO = 0.85;
export const TARGET_MAX_RATIO = 1.1;
export const MAX_RECOMPRESS = 2;
const MAX_REDUCE_DEPTH = 3;

export async function runSummarization(
  provider: LlmProvider,
  fullText: string,
  options: SummarizeJobOptions,
): Promise<SummarizeJobResult> {
  const maxInput = Math.max(1000, options.maxInputCharsPerRequest);
  const segments = fullText.split(MESSAGE_SEPARATOR);
  const chunks = chunkSegments(segments, maxInput);

  const finalInstruction = substitutePlaceholders(options.instructionTemplate, {
    targetChars: String(options.targetChars),
  });

  const callProvider = (text: string, instruction: string, targetChars: number) =>
    provider.summarize(text, {
      targetChars,
      instruction,
      model: options.model,
      temperature: options.temperature,
      signal: options.signal,
    });

  let finalText: string;

  if (chunks.length === 1) {
    options.onProgress?.("要約中…");
    finalText = (await callProvider(chunks[0], finalInstruction, options.targetChars)).trim();
  } else {
    // Map: 各チャンクを時系列を保ったまま中間要約する (§29)。
    let intermediates: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      options.onProgress?.(`分割要約中… (${i + 1}/${chunks.length})`);
      const target = intermediateTargetChars(options.targetChars, chunks.length);
      const instruction = intermediateInstruction(i + 1, chunks.length, target);
      const summary = await callProvider(chunks[i], instruction, target);
      intermediates.push(summary.trim());
    }

    // Reduce: 結合した中間要約が context を超えるなら再帰的に圧縮する (§29)。
    let depth = 0;
    while (
      countChars(intermediates.join("\n\n")) > maxInput &&
      intermediates.length > 1 &&
      depth < MAX_REDUCE_DEPTH
    ) {
      depth++;
      const rechunks = chunkSegments(intermediates, maxInput);
      const next: string[] = [];
      for (let i = 0; i < rechunks.length; i++) {
        options.onProgress?.(`中間要約を再圧縮中… (${i + 1}/${rechunks.length})`);
        const target = intermediateTargetChars(options.targetChars, rechunks.length);
        const instruction = intermediateInstruction(i + 1, rechunks.length, target);
        next.push((await callProvider(rechunks[i], instruction, target)).trim());
      }
      intermediates = next;
    }

    options.onProgress?.("最終要約を生成中…");
    const combined =
      "以下は長い会話ログを時系列順に分割して作成した中間要約です。これらを 1 つの要約に統合してください。\n\n" +
      intermediates.join("\n\n");
    finalText = (await callProvider(combined, finalInstruction, options.targetChars)).trim();
  }

  // 文字数収束 (§30)。substring では切らず、LLM に再圧縮させる。
  let recompressCount = 0;
  while (
    countChars(finalText) > options.targetChars * TARGET_MAX_RATIO &&
    recompressCount < MAX_RECOMPRESS
  ) {
    recompressCount++;
    options.onProgress?.(
      `目標文字数へ再圧縮中… (${recompressCount}/${MAX_RECOMPRESS})`,
    );
    const instruction = `この内容を維持したまま${options.targetChars}文字程度まで再圧縮してください。新しい設定や出来事を追加せず、文章として自然にまとめてください。`;
    finalText = (
      await callProvider(finalText, instruction, options.targetChars)
    ).trim();
  }

  return {
    text: finalText,
    chars: countChars(finalText),
    chunkCount: chunks.length,
    recompressCount,
  };
}

/**
 * メッセージ単位の segment 列を、1 リクエスト最大文字数以内のチャンクへ
 * greedy に詰める。メッセージ途中では切らない (§29)。
 * 単一 segment が上限を超える場合のみ、段落境界で分割する。
 */
export function chunkSegments(segments: string[], maxChars: number): string[] {
  const sepLen = MESSAGE_SEPARATOR.length;
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current.join(MESSAGE_SEPARATOR));
      current = [];
      currentLen = 0;
    }
  };

  for (const segment of segments) {
    if (segment.length === 0) continue;

    if (segment.length > maxChars) {
      // 1 メッセージが上限超え: やむを得ず段落境界で割る。
      flush();
      for (const piece of splitOversized(segment, maxChars)) {
        chunks.push(piece);
      }
      continue;
    }

    const addedLen = current.length === 0 ? segment.length : segment.length + sepLen;
    if (currentLen + addedLen > maxChars) flush();
    current.push(segment);
    currentLen += current.length === 1 ? segment.length : segment.length + sepLen;
  }
  flush();

  return chunks.length > 0 ? chunks : [""];
}

function splitOversized(text: string, maxChars: number): string[] {
  const paragraphs = text.split("\n\n");
  const out: string[] = [];
  let buf = "";
  for (const p of paragraphs) {
    const candidate = buf.length === 0 ? p : `${buf}\n\n${p}`;
    if (candidate.length > maxChars && buf.length > 0) {
      out.push(buf);
      buf = p;
    } else {
      buf = candidate;
    }
    // 段落単体が上限を超える場合は最後の手段として固定長で割る。
    while (buf.length > maxChars) {
      out.push(buf.slice(0, maxChars));
      buf = buf.slice(maxChars);
    }
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

function intermediateTargetChars(targetChars: number, chunkCount: number): number {
  const raw = Math.ceil((targetChars * 1.5) / Math.max(1, chunkCount));
  return Math.min(3000, Math.max(300, raw));
}

function intermediateInstruction(
  part: number,
  total: number,
  targetChars: number,
): string {
  return `あなたは物語のコンテキストを圧縮する編集者です。
これは長い会話ログを時系列順に分割したものの一部（${part}/${total}）です。

登場人物・性格・関係・重要な出来事・感情や関係性の変化・場所と時間・未解決の問題・伏線・明確に発言された重要な事実を欠落させず、時系列順を保ったまま日本語で要約してください。

新しい設定や出来事を追加してはいけません。

目標文字数：
${targetChars}文字`;
}
