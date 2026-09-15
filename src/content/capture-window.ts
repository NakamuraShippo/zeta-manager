/**
 * マウント中のメッセージを解析し、画面上の縦位置（上=古い）順に並べて返す。
 * デスクトップ版 content script とモバイル版（ユーザースクリプト）で共有する。
 *
 * - data-index は仮想スクロールのウィンドウ相対値のため時系列順の根拠にしない
 * - 縦方向に重なり合う node 群は再生成スワイプの変種カルーセルとみなし、
 *   表示中（ログ中央に最も近い）の 1 件のみを records に採用する。
 *   選ばれなかった変種は displaced として返す
 * - レイアウト情報が無い環境（テスト等）でのみ data-index → DOM 順で代替する
 */

import type { MessageRecord } from "../shared/types";
import { findLogContainer, findMessageNodes, parseMessage } from "./zeta-adapter";
import { partitionVariantSlots } from "./conversation-capture";

export interface CapturedWindow {
  records: MessageRecord[];
  displaced: MessageRecord[];
}

export function captureVisibleWindow(roomId: string): CapturedWindow {
  const now = Date.now();
  const entries: {
    rec: MessageRecord;
    top: number;
    height: number;
    centerX: number;
    domOrder: number;
  }[] = [];
  for (const node of findMessageNodes()) {
    try {
      const rec = parseMessage(node, roomId, now);
      if (!rec) continue;
      const rect = node.getBoundingClientRect();
      entries.push({
        rec,
        top: rect.top,
        height: rect.height,
        centerX: rect.left + rect.width / 2,
        domOrder: entries.length,
      });
    } catch (e) {
      console.warn("[ZetaLogCompanion] parseMessage failed:", e);
    }
  }

  const hasLayout = entries.some((e) => e.height > 0);
  if (!hasLayout) {
    entries.sort((a, b) =>
      a.rec.index !== b.rec.index
        ? a.rec.index - b.rec.index
        : a.domOrder - b.domOrder,
    );
    return { records: entries.map((e) => e.rec), displaced: [] };
  }

  const usable = entries.filter((e) => e.height > 0);
  usable.sort((a, b) => {
    if (Math.abs(a.top - b.top) > 0.5) return a.top - b.top;
    if (a.rec.index !== b.rec.index) return a.rec.index - b.rec.index;
    return a.domOrder - b.domOrder;
  });

  const logRect = findLogContainer()?.getBoundingClientRect();
  const anchorCenterX =
    logRect && logRect.width > 0
      ? logRect.left + logRect.width / 2
      : window.innerWidth / 2;
  const partition = partitionVariantSlots(
    usable.map((e) => ({ top: e.top, height: e.height, centerX: e.centerX })),
    anchorCenterX,
  );
  return {
    records: partition.visible.map((i) => usable[i].rec),
    displaced: partition.displaced.map((i) => usable[i].rec),
  };
}
