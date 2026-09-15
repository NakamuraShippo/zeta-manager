import type { MergeOptions } from "./conversation-capture";

/** 連続イベントでも表示更新を先送りし続けず、一定間隔で最新状態を描画する。 */
export function batchLiveUpdates(update: () => void, waitMs = 120): (() => void) & { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer !== null) return;
    timer = setTimeout(() => { timer = null; update(); }, waitMs);
  };
  schedule.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return schedule;
}

/** PC / モバイル共通。DOM 更新とスクロールを描画フレームごとにまとめる。 */
export class PassiveCapture {
  private frame: number | null = null;
  private observer: MutationObserver;
  private stopped = false;

  constructor(private readonly log: HTMLElement, private readonly scan: () => void) {
    this.observer = new MutationObserver(() => this.schedule());
    this.observer.observe(log, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ["data-key", "data-index"],
    });
    // 読み込み後にスクロール可能になる祖先や、入れ子のスクロールも拾う。
    log.ownerDocument.addEventListener("scroll", this.onScroll, { capture: true, passive: true });
  }

  private readonly onScroll = (event: Event): void => {
    const target = event.target;
    if (target instanceof HTMLElement &&
      (target.contains(this.log) || this.log.contains(target))) this.schedule();
  };

  private schedule(): void {
    if (this.stopped || this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (!this.stopped) this.scan();
    });
  }

  stop(): void {
    this.stopped = true;
    this.observer.disconnect();
    this.log.ownerDocument.removeEventListener("scroll", this.onScroll, true);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }
}

/** 最後に異なるメッセージ範囲を取得した位置との比較。逆向き flex でも増加=新しい側。 */
export class CaptureScrollTracker {
  private previous: { container: HTMLElement; keys: string; top: number; height: number } | null = null;

  observe(container: HTMLElement, keys: string[]): MergeOptions["scrollDirection"] {
    if (keys.length === 0) return undefined;
    const signature = JSON.stringify(keys);
    const previous = this.previous;
    if (previous?.container === container && previous.keys === signature) return undefined;
    this.previous = { container, keys: signature, top: container.scrollTop, height: container.scrollHeight };
    // 履歴の追加読み込みによる位置補正はスクロール方向の根拠にしない。
    if (!previous || previous.container !== container || previous.height !== container.scrollHeight) return undefined;
    const delta = container.scrollTop - previous.top;
    return Math.abs(delta) < 1 ? undefined : delta < 0 ? "older" : "newer";
  }

  reset(): void { this.previous = null; }
}
