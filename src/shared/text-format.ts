/**
 * MessageRecord 列 → LLM が理解しやすい構造化テキストへの変換 (§8)。
 */

import type { FormatOptions, MessageRecord } from "./types";

export const MESSAGE_SEPARATOR = "\n\n---\n\n";

export const DEFAULT_FORMAT_OPTIONS: FormatOptions = {
  speakerLabels: true,
  narrationLabels: true,
};

/** 1 メッセージ分のテキストを組み立てる。 */
export function formatMessage(
  record: MessageRecord,
  options: FormatOptions = DEFAULT_FORMAT_OPTIONS,
): string {
  const blocks: string[] = [];

  if (record.role === "user") {
    blocks.push(
      options.speakerLabels && record.speaker
        ? `[USER: ${record.speaker}]`
        : "[USER]",
    );
    for (const part of record.parts) {
      if (part.text) blocks.push(part.text);
    }
  } else {
    blocks.push(
      options.speakerLabels && record.speaker ? `[AI: ${record.speaker}]` : "[AI]",
    );
    for (const part of record.parts) {
      if (!part.text) continue;
      if (options.narrationLabels) {
        if (part.type === "narration") {
          blocks.push("[NARRATION]");
        } else {
          const speaker = options.speakerLabels
            ? (part.speaker ?? record.speaker)
            : null;
          blocks.push(speaker ? `[CHARACTER: ${speaker}]` : "[CHARACTER]");
        }
      }
      blocks.push(part.text);
    }
  }

  return blocks.join("\n\n");
}

/**
 * アクティブなメッセージを index 昇順に並べ、`---` 区切りで結合する。
 * 並び順は DOM 出現順ではなく data-index に従う (§7)。
 */
export function formatTranscript(
  records: MessageRecord[],
  options: FormatOptions = DEFAULT_FORMAT_OPTIONS,
): string {
  return formatMessageBlocks(records, options).join(MESSAGE_SEPARATOR);
}

/**
 * メッセージ単位の整形済みブロック列を返す。
 * Map-Reduce 要約 (§29) で「メッセージ途中で切らない」チャンク分割に使用する。
 */
export function formatMessageBlocks(
  records: MessageRecord[],
  options: FormatOptions = DEFAULT_FORMAT_OPTIONS,
): string[] {
  return records
    .filter((r) => r.active)
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((r) => formatMessage(r, options))
    .filter((block) => block.length > 0);
}
