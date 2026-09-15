/**
 * Map-Reduce 要約 (§29) と文字数収束 (§30) のテスト。
 */

import { describe, expect, it } from "vitest";
import {
  chunkSegments,
  MAX_RECOMPRESS,
  runSummarization,
} from "../src/llm/summarizer";
import { MESSAGE_SEPARATOR } from "../src/shared/text-format";
import { DEFAULT_SUMMARY_INSTRUCTION } from "../src/shared/types";
import type { LlmProvider, SummaryOptions } from "../src/llm/provider";

interface RecordedCall {
  text: string;
  instruction: string;
  targetChars: number;
}

class MockProvider implements LlmProvider {
  readonly kind = "mock";
  readonly endpoint = "http://127.0.0.1:9999/v1/chat/completions";
  readonly model = "mock-model";
  calls: RecordedCall[] = [];

  constructor(
    private readonly responder: (
      text: string,
      options: SummaryOptions,
      callIndex: number,
    ) => string,
  ) {}

  async summarize(text: string, options: SummaryOptions): Promise<string> {
    const index = this.calls.length;
    this.calls.push({
      text,
      instruction: options.instruction,
      targetChars: options.targetChars,
    });
    return this.responder(text, options, index);
  }
}

function jobOptions(overrides: Partial<Parameters<typeof runSummarization>[2]> = {}) {
  return {
    targetChars: 2000,
    instructionTemplate: DEFAULT_SUMMARY_INSTRUCTION,
    model: "mock-model",
    temperature: 0.2,
    maxInputCharsPerRequest: 12000,
    ...overrides,
  };
}

describe("runSummarization: 単発要約", () => {
  it("短い入力は 1 リクエストで要約し、instruction へ目標文字数を埋め込む (§28)", async () => {
    const provider = new MockProvider(() => "短い要約結果です。");
    const result = await runSummarization(provider, "[USER: コウ]\n\nこんにちは", jobOptions());

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].instruction).toContain("目標文字数：\n2000文字");
    expect(provider.calls[0].instruction).not.toContain("{{targetChars}}");
    expect(result.chunkCount).toBe(1);
    expect(result.recompressCount).toBe(0);
    expect(result.text).toBe("短い要約結果です。");
    expect(result.chars).toBe(9);
  });
});

describe("runSummarization: Map-Reduce (§29)", () => {
  it("上限超過時はメッセージ境界でチャンク分割し、中間要約を統合する", async () => {
    // 各 400 文字のメッセージ 6 件 → maxInput 1000 で 2 件ずつ 3 チャンク
    const segments = Array.from({ length: 6 }, (_, i) =>
      `[USER: コウ]\n\nSEG${i + 1} ` + "あ".repeat(380),
    );
    const fullText = segments.join(MESSAGE_SEPARATOR);

    const provider = new MockProvider((text) =>
      text.startsWith("以下は長い会話ログ") ? "統合された最終要約" : `中間(${text.match(/SEG\d+/g)?.join(",")})`,
    );

    const result = await runSummarization(
      provider,
      fullText,
      jobOptions({ targetChars: 500, maxInputCharsPerRequest: 1000 }),
    );

    // 3 map + 1 reduce
    expect(provider.calls).toHaveLength(4);
    expect(result.chunkCount).toBe(3);
    expect(result.text).toBe("統合された最終要約");

    // メッセージ途中で切らない: 各 map 入力の区切り片は必ず元 segment と一致する
    const mapCalls = provider.calls.slice(0, 3);
    const seen: string[] = [];
    for (const call of mapCalls) {
      for (const piece of call.text.split(MESSAGE_SEPARATOR)) {
        expect(segments).toContain(piece);
        seen.push(piece);
      }
      expect(call.instruction).toContain("時系列順");
    }
    // 全 segment がちょうど 1 回ずつ処理される
    expect(seen).toEqual(segments);

    // reduce 入力は中間要約を時系列順に含む
    const reduceCall = provider.calls[3];
    expect(reduceCall.text).toContain("中間(SEG1,SEG2)");
    expect(reduceCall.text).toContain("中間(SEG3,SEG4)");
    expect(reduceCall.text).toContain("中間(SEG5,SEG6)");
    expect(reduceCall.text.indexOf("SEG1")).toBeLessThan(reduceCall.text.indexOf("SEG5"));
    expect(reduceCall.instruction).toContain("目標文字数：\n500文字");
  });
});

describe("runSummarization: 文字数収束 (§30)", () => {
  it("1.10N を超えたら再圧縮を最大 2 回試行する", async () => {
    const long = "あ".repeat(300); // 目標 100 の 1.1 倍 = 110 を常に超える
    const provider = new MockProvider(() => long);
    const result = await runSummarization(
      provider,
      "本文",
      jobOptions({ targetChars: 100 }),
    );

    expect(result.recompressCount).toBe(MAX_RECOMPRESS);
    expect(provider.calls).toHaveLength(1 + MAX_RECOMPRESS);
    expect(provider.calls[1].instruction).toContain("100文字程度まで再圧縮");
    // substring で切らない: 長いままでも LLM 出力をそのまま返す
    expect(result.text).toBe(long);
    expect(result.chars).toBe(300);
  });

  it("再圧縮で範囲内に収まれば終了する", async () => {
    const provider = new MockProvider((_text, _options, index) =>
      index === 0 ? "あ".repeat(300) : "あ".repeat(95),
    );
    const result = await runSummarization(
      provider,
      "本文",
      jobOptions({ targetChars: 100 }),
    );
    expect(result.recompressCount).toBe(1);
    expect(provider.calls).toHaveLength(2);
    expect(result.chars).toBe(95);
  });

  it("許容範囲内 (0.85N〜1.10N) なら再圧縮しない", async () => {
    const provider = new MockProvider(() => "あ".repeat(105));
    const result = await runSummarization(
      provider,
      "本文",
      jobOptions({ targetChars: 100 }),
    );
    expect(result.recompressCount).toBe(0);
    expect(provider.calls).toHaveLength(1);
  });
});

describe("chunkSegments (§29)", () => {
  it("上限内なら 1 チャンクにまとめる", () => {
    const chunks = chunkSegments(["あ".repeat(100), "い".repeat(100)], 1000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("あ".repeat(100) + MESSAGE_SEPARATOR + "い".repeat(100));
  });

  it("境界を跨ぐ segment は次のチャンクへ送る", () => {
    const a = "あ".repeat(600);
    const b = "い".repeat(600);
    const chunks = chunkSegments([a, b], 1000);
    expect(chunks).toEqual([a, b]);
  });

  it("単一 segment が上限を超える場合のみ段落境界で分割する", () => {
    const paragraphs = ["一".repeat(400), "二".repeat(400), "三".repeat(400)];
    const oversized = paragraphs.join("\n\n");
    const chunks = chunkSegments([oversized], 900);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(900);
    }
    expect(chunks.join("\n\n")).toBe(oversized);
  });

  it("空 segment は無視する", () => {
    expect(chunkSegments(["", "本文", ""], 1000)).toEqual(["本文"]);
  });
});
