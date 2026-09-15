// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { batchLiveUpdates, CaptureScrollTracker, PassiveCapture } from "../src/content/passive-capture";
import { ConversationStore } from "../src/content/conversation-capture";
import type { MessageRecord } from "../src/shared/types";

const captures: PassiveCapture[] = [];
beforeEach(() => { vi.useFakeTimers(); document.body.innerHTML = "<main><div role='log'></div></main><aside></aside>"; });
afterEach(() => { captures.splice(0).forEach((capture) => capture.stop()); vi.useRealTimers(); });
function setup() {
  const log = document.querySelector<HTMLElement>("[role=log]")!;
  const scan = vi.fn();
  captures.push(new PassiveCapture(log, scan));
  return { log, scan };
}

describe("スクロール時の自動取得", () => {
  it("DOM 更新のないスクロールも取得し、同一フレームのイベントをまとめる", async () => {
    const { log, scan } = setup();
    for (let i = 0; i < 20; i++) log.parentElement!.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(20);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("スクロール後に遅れて読み込まれた DOM も取り込む", async () => {
    const { log, scan } = setup();
    log.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(20);
    log.textContent = "後から読み込まれた会話";
    await vi.advanceTimersByTimeAsync(20);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("無関係なペインのスクロールでは解析しない", async () => {
    const { scan } = setup();
    document.querySelector("aside")!.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(20);
    expect(scan).not.toHaveBeenCalled();
  });

  it("Room を離れた後は予約済み取得と監視を解除する", async () => {
    const { log, scan } = setup();
    log.dispatchEvent(new Event("scroll"));
    captures[0].stop();
    log.textContent = "別の会話";
    log.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(100);
    expect(scan).not.toHaveBeenCalled();
  });

  it("表示更新は連続取得中も定期的に実行し、停止後に最新状態を表示する", async () => {
    let latest = 0;
    const shown: number[] = [];
    const schedule = batchLiveUpdates(() => shown.push(latest));
    for (let i = 1; i <= 20; i++) {
      latest = i;
      schedule();
      await vi.advanceTimersByTimeAsync(16);
    }
    expect(shown.length).toBeGreaterThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(120);
    expect(shown.at(-1)).toBe(20);
    schedule();
    schedule.cancel();
    const count = shown.length;
    await vi.advanceTimersByTimeAsync(120);
    expect(shown).toHaveLength(count);
  });
});

describe("スクロールによる取得範囲の位置判断", () => {
  it.each([500, -500])("DOM の遅延更新まで方向判断の基準を維持する（位置=%i）", (top) => {
    const tracker = new CaptureScrollTracker();
    const container = document.createElement("div");
    container.scrollTop = top;
    tracker.observe(container, ["A"]);
    container.scrollTop = top - 200;
    expect(tracker.observe(container, ["A"])).toBeUndefined();
    expect(tracker.observe(container, ["B"])).toBe("older");
    container.scrollTop = top;
    expect(tracker.observe(container, ["A"])).toBe("newer");
  });

  it("追加読み込みによる高さ変更や Room 切替を移動方向に使わない", () => {
    const tracker = new CaptureScrollTracker();
    const container = document.createElement("div");
    tracker.observe(container, ["A"]);
    Object.defineProperty(container, "scrollHeight", { value: 2000 });
    container.scrollTop = 500;
    expect(tracker.observe(container, ["B"])).toBeUndefined();
    tracker.reset();
    container.scrollTop = 0;
    expect(tracker.observe(container, ["C"])).toBeUndefined();
  });

  it("2000件を下から上へ手動スクロール取得しても非単調な ID に影響されない", () => {
    const all: MessageRecord[] = Array.from({ length: 2000 }, (_, i) => ({
      roomId: "room", messageKey: `message-${i % 2 ? 100000 + i : 900000 + i}`,
      index: i + 1, role: "user", speaker: null,
      parts: [{ type: "user", text: String(i) }], capturedAt: 1, updatedAt: 1,
      contentHash: String(i), active: true,
    }));
    const tracker = new CaptureScrollTracker();
    const container = document.createElement("div");
    const store = new ConversationStore();
    for (let start = 1980; start >= 0; start -= 20) {
      const window = all.slice(start, start + 20);
      container.scrollTop = start * 100;
      const scrollDirection = tracker.observe(container, window.map((r) => r.messageKey));
      store.mergeWindow(window, { scrollDirection });
    }
    expect(store.getActiveSorted().map((r) => r.messageKey)).toEqual(all.map((r) => r.messageKey));
  });
});
