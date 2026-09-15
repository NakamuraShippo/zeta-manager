import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runFullSync } from "../src/content/full-sync";

function scrollContainer(reverse = false): HTMLElement {
  const min = reverse ? -1000 : 0;
  const max = reverse ? 0 : 1000;
  let top = reverse ? -500 : 500;
  return {
    clientHeight: 500,
    scrollHeight: 1500,
    get scrollTop() { return top; },
    set scrollTop(value: number) { top = Math.max(min, Math.min(max, value)); },
  } as HTMLElement;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("全履歴同期の完了判定", () => {
  it.each([20, 300])("描画が%i ms後に更新されたら安定を待ち、全範囲を取得する", async (renderDelay) => {
    let top = 500;
    let renderedTop = 500;
    const positions: number[] = [];
    const container = {
      clientHeight: 500, scrollHeight: 1500,
      get scrollTop() { return top; },
      set scrollTop(value: number) {
        const next = Math.max(0, Math.min(1000, value));
        if (next !== top) {
          top = next;
          setTimeout(() => { renderedTop = next; }, renderDelay);
        }
      },
      querySelectorAll: () => [{ dataset: { key: `message-${renderedTop}` }, textContent: String(renderedTop) }],
    } as unknown as HTMLElement;
    const start = Date.now();
    const promise = runFullSync({
      container, loadWaitMs: 0,
      collect: () => { positions.push(renderedTop); return new Set(positions).size; },
    });
    await vi.runAllTimersAsync();
    expect((await promise).aborted).toBe(false);
    expect([...new Set(positions)]).toEqual([0, 300, 600, 900, 1000]);
    expect(container.scrollTop).toBe(500);
    // 旧処理は初回+8走査の450msと復元680ms = 4730ms。
    expect(Date.now() - start).toBeLessThan(4730);
  });

  it("表示更新が検出できなければ固定待機を維持する", async () => {
    const container = scrollContainer();
    const capturedAt: number[] = [];
    const start = Date.now();
    const promise = runFullSync({
      container, loadWaitMs: 0, maxSteps: 1,
      collect: () => { capturedAt.push(Date.now() - start); return 1; },
    });
    await vi.runAllTimersAsync();
    expect((await promise).aborted).toBe(true);
    expect(capturedAt).toEqual([450, 900]);
  });

  it("空の中間 DOM や連続更新を安定した表示として扱わない", async () => {
    const container = scrollContainer();
    let text: string | null = "old";
    container.querySelectorAll = (() => text === null ? [] : [
      { dataset: { key: "message-current" }, textContent: text },
    ]) as unknown as typeof container.querySelectorAll;
    setTimeout(() => { text = null; }, 20);
    setTimeout(() => { text = "loading"; }, 120);
    setTimeout(() => { text = "ready"; }, 160);
    const start = Date.now();
    const captured: { at: number; text: string | null }[] = [];
    const promise = runFullSync({
      container, loadWaitMs: 0, maxSteps: 1,
      collect: () => { captured.push({ at: Date.now() - start, text }); return 1; },
    });
    await vi.runAllTimersAsync();
    await promise;
    expect(captured[0].text).toBe("ready");
    expect(captured[0].at).toBeGreaterThanOrEqual(240);
    expect(captured[0].at).toBeLessThan(450);
  });

  it("過去ログ追加の高さ変化が続く間は待ち、安定したら次の読み込みへ進む", async () => {
    const container = scrollContainer();
    let height = 1500;
    Object.defineProperty(container, "scrollHeight", { get: () => height });
    for (const delay of [20, 80, 160]) setTimeout(() => { height += 100; }, delay);
    const start = Date.now();
    const loadingAt: number[] = [];
    const promise = runFullSync({
      container, collect: () => 1, loadWaitMs: 400,
      onProgress: (p) => { if (p.phase === "loading") loadingAt.push(Date.now() - start); },
    });
    await vi.runAllTimersAsync();
    expect((await promise).aborted).toBe(false);
    expect(loadingAt[1]).toBeGreaterThanOrEqual(260);
    expect(loadingAt[1]).toBeLessThan(550);
  });

  it("適応待機中の Room 切替でも速やかに中断し位置を復元する", async () => {
    const container = scrollContainer();
    let abort = false;
    setTimeout(() => { abort = true; }, 60);
    const collect = vi.fn(() => 1);
    const promise = runFullSync({ container, collect, loadWaitMs: 0, shouldAbort: () => abort });
    await vi.runAllTimersAsync();
    expect((await promise).aborted).toBe(true);
    expect(collect).not.toHaveBeenCalled();
    expect(container.scrollTop).toBe(500);
  });

  it.each([false, true])("末尾まで取得して元の位置に戻す（逆順=%s）", async (reverse) => {
    const container = scrollContainer(reverse);
    const original = container.scrollTop;
    const collect = vi.fn(() => 1);
    const scanning = vi.fn();
    const promise = runFullSync({
      container, collect, settleMs: 0, loadWaitMs: 0,
      onProgress: (p) => { if (p.phase === "scanning") scanning(); },
    });
    await vi.runAllTimersAsync();
    expect((await promise).aborted).toBe(false);
    expect(container.scrollTop).toBe(original);
    // 走査ごとの取得と末尾の最終取得のみ。復元先を再接合しない。
    expect(collect).toHaveBeenCalledTimes(scanning.mock.calls.length + 1);
  });

  it("下降走査の上限では完了にせず、位置を復元する", async () => {
    const container = scrollContainer();
    const phases: string[] = [];
    const promise = runFullSync({
      container, collect: () => 1, settleMs: 0, loadWaitMs: 0, maxSteps: 1,
      onProgress: (p) => phases.push(p.phase),
    });
    await vi.runAllTimersAsync();
    expect((await promise).aborted).toBe(true);
    expect(phases).not.toContain("done");
    expect(container.scrollTop).toBe(500);
  });

  it("過去ログ読み込みの上限でも完了にしない", async () => {
    const promise = runFullSync({
      container: scrollContainer(), collect: () => 1,
      settleMs: 0, loadWaitMs: 0, maxTopJumps: 1,
    });
    await vi.runAllTimersAsync();
    expect((await promise).aborted).toBe(true);
  });

  it("取得に失敗した場合は末尾まで進んでも未完了にする", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const promise = runFullSync({
      container: scrollContainer(), collect: () => { throw new Error("capture failed"); },
      settleMs: 0, loadWaitMs: 0,
    });
    await vi.runAllTimersAsync();
    expect((await promise).aborted).toBe(true);
  });
});
