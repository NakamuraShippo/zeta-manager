/**
 * Full Sync: 仮想スクロール領域を自動走査して過去ログを収集する (§9 / §10)。
 *
 * 実サイトの Zeta は
 * - 過去ログを段階的にしか読み込まない（最上部到達で次のチャンクをロード）
 * - 画面外のメッセージを DOM から排除する
 * ため、次の 2 フェーズで行う:
 *
 *   Phase A: 最上部へのジャンプを繰り返し、読み込み可能な過去ログを
 *            すべてロードさせる（このフェーズでは順序を確定しない）
 *   Phase B: 最上部から下方向へ一定幅ずつスクロールしながら取得する。
 *            上→下の遭遇順がそのまま時系列になる。
 *
 * 終了後（中断・例外時も含む）は必ず元のスクロール位置へ戻す。
 */

import { sleep } from "../shared/utils";

export interface FullSyncProgress {
  phase: "loading" | "scanning" | "restoring" | "done" | "aborted";
  collectedMessages: number;
  steps: number;
}

export interface FullSyncOptions {
  /** スクロール可能なコンテナ（findScrollContainer で解決したもの） */
  container: HTMLElement;
  /** 現在 DOM を解析してストアへ接合し、時系列リストの件数を返す（Phase B で使用） */
  collect: () => number;
  onProgress?: (progress: FullSyncProgress) => void;
  /** Room 遷移などで中断すべきとき true を返す */
  shouldAbort?: () => boolean;
  /** Phase B の DOM 更新待機上限 (ms)。更新後に安定すれば早く進む。 */
  settleMs?: number;
  /** Phase A で 1 回のジャンプ後、チャンク読み込みを待つ最大時間 (ms) */
  loadWaitMs?: number;
  /** 「増えない」が何回続いたら境界とみなすか */
  stagnantLimit?: number;
  /** Phase B の最大ステップ数（暴走防止） */
  maxSteps?: number;
  /** Phase A の最大ジャンプ回数（暴走防止） */
  maxTopJumps?: number;
}

export interface FullSyncResult {
  aborted: boolean;
  collectedMessages: number;
  steps: number;
}

/**
 * メッセージ log 要素から実際にスクロールする祖先要素を探す。
 * body / documentElement までは遡らない（ページ全体をスクロールさせて
 * Zeta のレイアウトを乱さないため）。見つからなければ log 自身を返す。
 */
export function findScrollContainer(log: HTMLElement): HTMLElement {
  let el: HTMLElement | null = log;
  while (el && el !== document.body && el !== document.documentElement) {
    if (el.scrollHeight > el.clientHeight + 10) {
      const overflowY = getComputedStyle(el).overflowY;
      if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
        return el;
      }
    }
    el = el.parentElement;
  }
  return log;
}

/** container が最下部（最新側）付近にあるか。col-reverse では bottom = scrollTop 0。 */
export function isNearBottom(container: HTMLElement, thresholdPx = 80): boolean {
  const style = getComputedStyle(container);
  if (style.flexDirection === "column-reverse") {
    return Math.abs(container.scrollTop) <= thresholdPx;
  }
  return (
    container.scrollHeight - container.clientHeight - container.scrollTop <=
    thresholdPx
  );
}

export async function runFullSync(options: FullSyncOptions): Promise<FullSyncResult> {
  const {
    container,
    collect,
    onProgress,
    shouldAbort = () => false,
    settleMs = 450,
    loadWaitMs = 2500,
    stagnantLimit = 3,
    maxSteps = 600,
    maxTopJumps = 150,
  } = options;

  const originalScrollTop = container.scrollTop;
  let steps = 0;
  let collected = 0;
  let collectionFailed = false;

  const safeCollect = (): number => {
    try {
      collected = Math.max(collected, collect());
    } catch (e) {
      collectionFailed = true;
      console.warn("[ZetaLogCompanion] full-sync collect failed:", e);
    }
    return collected;
  };

  const report = (phase: FullSyncProgress["phase"]) => {
    onProgress?.({ phase, collectedMessages: collected, steps });
  };

  /** 最上部（最古側）へジャンプする。col-reverse では負方向へも clamp される。 */
  const jumpToTop = () => {
    container.scrollTop = -1e9;
  };

  // レイアウト計算を伴う innerText / 座標計測は待機中に行わない。
  const windowSignature = (): string | null => {
    if (typeof container.querySelectorAll !== "function") return null;
    const nodes = container.querySelectorAll<HTMLElement>('[data-key^="message-"][data-index]');
    if (nodes.length === 0) return null;
    return JSON.stringify(Array.from(nodes, (node) => [node.dataset.key, node.textContent]));
  };

  const waitForRender = async (before: string | null): Promise<void> => {
    const deadline = Date.now() + settleMs;
    let last = before;
    let changed = false;
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      await sleep(Math.min(40, deadline - Date.now()));
      if (shouldAbort()) return;
      const current = windowSignature();
      if (current !== last) {
        last = current;
        stableSince = Date.now();
        changed = true;
      }
      // 空の中間 DOM や、まだ旧ウィンドウのままなら早送りしない。
      if (changed && current !== null && Date.now() - stableSince >= 80) return;
    }
  };

  /** ジャンプ後、チャンク読み込みによる scrollHeight / scrollTop の変化を待つ。 */
  const waitForLoad = async (): Promise<boolean> => {
    const baseHeight = container.scrollHeight;
    const baseTop = container.scrollTop;
    const deadline = Date.now() + loadWaitMs;
    while (Date.now() < deadline) {
      await sleep(Math.min(50, deadline - Date.now()));
      if (shouldAbort()) return false;
      if (
        container.scrollHeight !== baseHeight ||
        Math.abs(container.scrollTop - baseTop) > 1
      ) {
        // 読み込みが速ければ100msの安定で進み、変化が続く間は最大450ms待つ。
        let height = container.scrollHeight;
        let top = container.scrollTop;
        let stableSince = Date.now();
        const settleDeadline = Date.now() + settleMs;
        while (Date.now() < settleDeadline) {
          await sleep(Math.min(50, settleDeadline - Date.now()));
          if (shouldAbort()) return false;
          if (height !== container.scrollHeight || Math.abs(top - container.scrollTop) > 1) {
            height = container.scrollHeight;
            top = container.scrollTop;
            stableSince = Date.now();
          }
          if (Date.now() - stableSince >= 100) break;
        }
        return true;
      }
    }
    return false;
  };

  let completed = false;
  try {
    // -------- Phase A: 最上部まで読み込み切る --------
    let stagnantA = 0;
    let jumps = 0;
    while (stagnantA < 2 && jumps < maxTopJumps) {
      if (shouldAbort()) break;
      jumpToTop();
      jumps++;
      steps = jumps;
      report("loading");
      const grew = await waitForLoad();
      if (shouldAbort()) break;
      if (grew) {
        stagnantA = 0;
      } else {
        stagnantA++;
      }
    }

    if (!shouldAbort()) {
      // -------- Phase B: 最上部から下方向へ取得 --------
      const beforeTop = windowSignature();
      jumpToTop();
      await waitForRender(beforeTop);

      let stagnantB = 0;
      let scanSteps = 0;
      while (stagnantB < stagnantLimit && scanSteps < maxSteps) {
        if (shouldAbort()) break;

        const prevCount = collected;
        safeCollect();
        report("scanning");

        const before = container.scrollTop;
        const beforeWindow = windowSignature();
        container.scrollTop =
          before + Math.max(120, container.clientHeight * 0.6);
        steps++;
        scanSteps++;

        await waitForRender(beforeWindow);
        if (shouldAbort()) break;

        const after = container.scrollTop;
        const moved = Math.abs(after - before) >= 1;
        const grew = collected > prevCount;
        if (!moved && !grew) {
          stagnantB++;
        } else {
          stagnantB = 0;
        }
      }

      if (!shouldAbort()) {
        safeCollect();
        completed = stagnantA >= 2 && stagnantB >= stagnantLimit && !collectionFailed;
      }
    }
  } finally {
    // どんな経路でも必ず元のスクロール位置へ戻す (§39-12)
    report("restoring");
    try {
      container.scrollTop = originalScrollTop;
      await sleep(Math.min(settleMs, 300));
      // 仮想リストの再描画を促すナッジ（scroll イベントを確実に発火させる）
      container.scrollTop = originalScrollTop + 1;
      await sleep(80);
      container.scrollTop = originalScrollTop;
      await sleep(Math.min(settleMs, 300));
    } catch (e) {
      console.warn("[ZetaLogCompanion] full-sync scroll restore failed:", e);
    }
    // 復元先は走査順から外れるため、再構築中の順序リストには接合しない。
  }

  if (!completed) {
    report("aborted");
    return { aborted: true, collectedMessages: collected, steps };
  }
  report("done");
  return { aborted: false, collectedMessages: collected, steps };
}
