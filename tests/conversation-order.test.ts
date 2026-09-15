import { describe, expect, it } from "vitest";
import { ConversationStore } from "../src/content/conversation-capture";
import type { MessageRecord } from "../src/shared/types";

function records(): MessageRecord[] {
  // B の ID だけが大きい。画面で確認した A→B→C→D を正とする。
  return [100000, 900000, 300000, 400000].map((id, i) => ({
    roomId: "room",
    messageKey: `message-${id}`,
    index: i + 1,
    role: "user",
    speaker: null,
    parts: [{ type: "user", text: "ABCD"[i] }],
    capturedAt: 1,
    updatedAt: 1,
    contentHash: String(id),
    active: true,
  }));
}

const labels = (store: ConversationStore) =>
  store.getActiveSorted().map((r) => r.parts[0].text).join("");

describe("ID の大小に依存しない会話順序", () => {
  it("上方向の離れた範囲を、直前の表示範囲の前へ挿入する", () => {
    const [a, b, c, d] = records();
    const store = new ConversationStore();
    store.seed([a, c, d]);
    store.mergeWindow([c]);
    store.mergeWindow([b], { scrollDirection: "older" });
    expect(labels(store)).toBe("ABCD");
  });

  it("下方向の離れた範囲を、直前の表示範囲の後ろへ挿入する", () => {
    const [a, b, c, d] = records();
    const store = new ConversationStore();
    store.seed([a, b, d]);
    store.mergeWindow([b]);
    store.mergeWindow([c], { scrollDirection: "newer" });
    expect(labels(store)).toBe("ABCD");
  });

  it("共通アンカーがなくても取得範囲内の順序を保つ", () => {
    const [a, b, c] = records();
    const store = new ConversationStore();
    store.mergeWindow([a]);
    store.mergeWindow([b, c]);
    expect(labels(store)).toBe("ABC");
  });

  it("全履歴同期の離れた範囲は上から下の遭遇順で接合する", () => {
    const [a, b, c, d] = records();
    const store = new ConversationStore();
    store.beginRebuild();
    store.mergeWindow([a, b]);
    store.mergeWindow([c, d]);
    store.finishRebuild();
    expect(labels(store)).toBe("ABCD");
  });

  it.each([[2, 4], [1, 3], [0, 2], [0, 0]])(
    "部分同期 %i..%i の未走査分は以前の前後関係で戻す",
    (start, end) => {
      const all = records();
      const store = new ConversationStore();
      store.seed(all);
      store.beginRebuild();
      store.mergeWindow(all.slice(start, end));
      store.finishRebuild();
      expect(labels(store)).toBe("ABCD");
      expect(store.getActiveSorted().map((r) => r.index)).toEqual([1, 2, 3, 4]);
    },
  );

  it("同期中に無効化された旧変種は復元しない", () => {
    const [a, b, c, d] = records();
    const store = new ConversationStore();
    store.seed([a, b, c, d]);
    store.beginRebuild();
    store.mergeWindow([c, d], { displaced: [b] });
    store.finishRebuild();
    expect(labels(store)).toBe("ACD");
  });

  it("2000件の履歴を途中から部分同期しても未走査区間を元の位置へ戻す", () => {
    const template = records()[0];
    const all = Array.from({ length: 2000 }, (_, i) => ({
      ...template,
      messageKey: `message-${i % 2 === 0 ? 900000 + i : 100000 + i}`,
      index: i + 1,
      parts: [{ type: "user" as const, text: String(i) }],
      contentHash: String(i),
    }));
    const store = new ConversationStore();
    store.seed(all);
    store.beginRebuild();
    for (let start = 300; start < 1500; start += 50) {
      store.mergeWindow(all.slice(start, start + 20));
    }
    store.finishRebuild();
    expect(store.getActiveSorted().map((r) => r.messageKey))
      .toEqual(all.map((r) => r.messageKey));
    expect(store.getActiveSorted().map((r) => r.index))
      .toEqual(all.map((r) => r.index));
  });
});
