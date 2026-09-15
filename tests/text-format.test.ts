/**
 * 構造化テキスト変換 (§8) のテスト。
 */

import { describe, expect, it } from "vitest";
import {
  formatMessage,
  formatMessageBlocks,
  formatTranscript,
  MESSAGE_SEPARATOR,
} from "../src/shared/text-format";
import { countChars } from "../src/shared/utils";
import type { MessageRecord } from "../src/shared/types";

function record(partial: Partial<MessageRecord>): MessageRecord {
  return {
    roomId: "room-1",
    messageKey: "message-x",
    index: 1,
    role: "user",
    speaker: null,
    parts: [],
    capturedAt: 0,
    updatedAt: 0,
    contentHash: "h",
    active: true,
    ...partial,
  };
}

const user1 = record({
  messageKey: "message-1",
  index: 1,
  role: "user",
  speaker: "コウ",
  parts: [
    {
      type: "user",
      speaker: "コウ",
      text: "5日目\nコウは友人宅を最後に軽く掃除して……",
    },
  ],
});

const ai2 = record({
  messageKey: "message-2",
  index: 2,
  role: "ai",
  speaker: "翠",
  parts: [
    { type: "narration", text: "五日目。コウは友人宅を出た。\nまた同じことをした……" },
    {
      type: "character",
      speaker: "翠",
      text: "翠のスマホが鳴った。\n仕事の依頼主。三度目の着信。",
    },
  ],
});

const user3 = record({
  messageKey: "message-3",
  index: 3,
  role: "user",
  speaker: "コウ",
  parts: [
    { type: "user", speaker: "コウ", text: "ちゃららん…🎵\n聞き慣れた着信音が……" },
  ],
});

describe("formatTranscript (§8)", () => {
  it("仕様書のサンプルと同じ構造化テキストを生成する", () => {
    const expected = [
      "[USER: コウ]",
      "",
      "5日目",
      "コウは友人宅を最後に軽く掃除して……",
      "",
      "---",
      "",
      "[AI: 翠]",
      "",
      "[NARRATION]",
      "",
      "五日目。コウは友人宅を出た。",
      "また同じことをした……",
      "",
      "[CHARACTER: 翠]",
      "",
      "翠のスマホが鳴った。",
      "仕事の依頼主。三度目の着信。",
      "",
      "---",
      "",
      "[USER: コウ]",
      "",
      "ちゃららん…🎵",
      "聞き慣れた着信音が……",
    ].join("\n");

    expect(
      formatTranscript([user1, ai2, user3], {
        speakerLabels: true,
        narrationLabels: true,
      }),
    ).toBe(expected);
  });

  it("入力順に依存せず index 順で出力し、active=false を除外する (§7)", () => {
    const inactive = record({
      messageKey: "message-old",
      index: 2,
      role: "ai",
      speaker: "翠",
      active: false,
      parts: [{ type: "character", speaker: "翠", text: "旧世代の返信" }],
    });
    const text = formatTranscript([user3, inactive, ai2, user1]);
    expect(text.indexOf("[USER: コウ]")).toBe(0);
    expect(text.indexOf("5日目")).toBeLessThan(text.indexOf("[NARRATION]"));
    expect(text.indexOf("[NARRATION]")).toBeLessThan(text.indexOf("🎵"));
    expect(text).not.toContain("旧世代の返信");
  });

  it("話者ラベル OFF では [USER]/[AI]/[CHARACTER] になる", () => {
    const text = formatTranscript([user1, ai2], {
      speakerLabels: false,
      narrationLabels: true,
    });
    expect(text).toContain("[USER]\n");
    expect(text).toContain("[AI]\n");
    expect(text).toContain("[CHARACTER]\n");
    expect(text).not.toContain("[USER: コウ]");
    expect(text).not.toContain("[CHARACTER: 翠]");
  });

  it("ナレーションラベル OFF では [NARRATION]/[CHARACTER] を省略し本文は残す", () => {
    const text = formatMessage(ai2, {
      speakerLabels: true,
      narrationLabels: false,
    });
    expect(text).toBe(
      [
        "[AI: 翠]",
        "",
        "五日目。コウは友人宅を出た。",
        "また同じことをした……",
        "",
        "翠のスマホが鳴った。",
        "仕事の依頼主。三度目の着信。",
      ].join("\n"),
    );
  });

  it("formatMessageBlocks はメッセージ単位のブロックを返す (§29)", () => {
    const blocks = formatMessageBlocks([user3, ai2, user1]);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].startsWith("[USER: コウ]")).toBe(true);
    expect(blocks[1].startsWith("[AI: 翠]")).toBe(true);
    expect(blocks.join(MESSAGE_SEPARATOR)).toBe(
      formatTranscript([user1, ai2, user3]),
    );
  });
});

describe("countChars", () => {
  it("サロゲートペア（絵文字）を 1 文字と数える", () => {
    expect(countChars("🎵")).toBe(1);
    expect("🎵".length).toBe(2);
    expect(countChars("あいう🎵えお")).toBe(6);
  });
});
