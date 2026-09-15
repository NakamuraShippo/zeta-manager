/**
 * 取得済みメッセージのインメモリストアと時系列順序の一元管理。
 *
 * 実サイトの Zeta では:
 * - 仮想スクロールにより画面外のメッセージは DOM から完全に排除される
 * - data-index はマウント中のウィンドウに対する相対値で、全履歴の通し番号ではない
 *
 * そのため順序は data-index に依存せず、
 * 「取得時の画面上の縦位置で並べたマウント済みウィンドウ（連続区間）」を
 * 既知の messageKey（アンカー）で既存の時系列リストへ接合して管理する。
 * MessageRecord.index はこのストアが振り直す通し番号 (1..N)。
 *
 * 仮想リストのマウント範囲は連続しているため、
 * 「両端がマウントされている区間の内側に、マウントされていない既知メッセージが
 * 残っている」場合、それは再生成・削除で消えたとみなせる (§12 相当)。
 *
 * chrome API / DOM には依存しない（unit test 可能）。
 */

import type { MessageRecord } from "../shared/types";

export interface UpsertStats {
  added: number;
  updated: number;
  unchanged: number;
  /** 再生成・削除により active=false へ落としたメッセージ数 */
  deactivated: number;
}

export interface MergeOptions {
  /** 直前に取得した範囲からの移動方向。共通アンカーがない場合のみ使う。 */
  scrollDirection?: "older" | "newer";
  /**
   * 取得時にスクロール位置がリスト最下部（最新側）だったか。
   * true の場合、最後のアンカーより後ろに残る未マウントの既知メッセージは
   * 消滅（再生成による差し替え等）とみなして active=false にする。
   */
  atBottom?: boolean;
  /**
   * 再生成スワイプの変種カルーセルで「表示中でない」と判定されたメッセージ。
   * 同一スロットの非表示変種であることが確定しているため、既存ログに居れば
   * active=false へ落として順序リストから除去する（本体は履歴として保持）。
   */
  displaced?: MessageRecord[];
}

/** 変種スロット判定用の最小情報（レイアウト座標）。 */
export interface SlotItem {
  top: number;
  height: number;
  centerX: number;
}

/**
 * 縦方向に重なり合うメッセージ node 群を「同一スロットの変種グループ」とみなし、
 * 各グループから表示中の 1 件（中心 X が anchorCenterX に最も近いもの）を選ぶ。
 * items は top 昇順で渡すこと。戻り値はいずれも items の添字。
 */
export function partitionVariantSlots(
  items: SlotItem[],
  anchorCenterX: number,
): { visible: number[]; displaced: number[] } {
  const groups: number[][] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const current = groups[groups.length - 1];
    if (current) {
      const rep = items[current[0]];
      const overlap =
        Math.min(rep.top + rep.height, item.top + item.height) -
        Math.max(rep.top, item.top);
      const minHeight = Math.max(1, Math.min(rep.height, item.height));
      if (overlap > minHeight * 0.5) {
        current.push(i);
        continue;
      }
    }
    groups.push([i]);
  }

  const visible: number[] = [];
  const displaced: number[] = [];
  for (const group of groups) {
    if (group.length === 1) {
      visible.push(group[0]);
      continue;
    }
    let best = group[0];
    for (const idx of group) {
      if (
        Math.abs(items[idx].centerX - anchorCenterX) <
        Math.abs(items[best].centerX - anchorCenterX)
      ) {
        best = idx;
      }
    }
    visible.push(best);
    for (const idx of group) {
      if (idx !== best) displaced.push(idx);
    }
  }
  return { visible, displaced };
}

export class ConversationStore {
  private byKey = new Map<string, MessageRecord>();
  /** active なメッセージの時系列順 messageKey リスト（唯一の順序ソース） */
  private order: string[] = [];
  private pos = new Map<string, number>();
  private dirtyKeys = new Set<string>();
  /** Full Sync の上→下パス中の旧順序退避 */
  private rebuildBackup: string[] | null = null;
  private lastWindow: string[] = [];

  /**
   * DB に保存済みの active メッセージ（index 昇順）で初期化する。
   * セッションを跨いだ順序の安定化に使う。dirty にはしない。
   * index の振り直しは行わない（最初の mergeWindow が dirty 付きで揃えるため、
   * DB 内の番号と食い違う中間状態を書き込まずに済む）。
   */
  seed(records: MessageRecord[]): void {
    for (const rec of records) {
      if (this.byKey.has(rec.messageKey)) continue;
      this.byKey.set(rec.messageKey, {
        ...rec,
        active: true,
        parts: rec.parts.map((p) => ({ ...p })),
      });
      this.order.push(rec.messageKey);
    }
    this.rebuildPositions();
  }

  /**
   * 画面上の縦位置順（上=古い）に並べたマウント済みウィンドウを取り込む。
   */
  mergeWindow(mounted: MessageRecord[], options: MergeOptions = {}): UpsertStats {
    const stats: UpsertStats = {
      added: 0,
      updated: 0,
      unchanged: 0,
      deactivated: 0,
    };

    // 0. 再生成スワイプで表示中でないと確定した変種を無効化する。
    //    既存ログとの「比較」はスロット位置（縦の重なり）で済んでいるため、
    //    ここでは順序リストから外し active=false で履歴に残すだけでよい。
    const mountedKeySet = new Set(mounted.map((m) => m.messageKey));
    if (options.displaced && options.displaced.length > 0) {
      const removePositions: number[] = [];
      for (const variant of options.displaced) {
        if (mountedKeySet.has(variant.messageKey)) continue;
        const existing = this.byKey.get(variant.messageKey);
        if (existing) {
          if (existing.active) {
            existing.active = false;
            this.dirtyKeys.add(existing.messageKey);
            stats.deactivated++;
          }
        } else {
          // 未取得の変種も履歴（非アクティブ）として保持する (§12)
          this.byKey.set(variant.messageKey, {
            ...variant,
            active: false,
            parts: variant.parts.map((p) => ({ ...p })),
          });
          this.dirtyKeys.add(variant.messageKey);
        }
        const p = this.pos.get(variant.messageKey);
        if (p !== undefined) removePositions.push(p);
      }
      if (removePositions.length > 0) {
        removePositions.sort((a, b) => b - a);
        for (const p of removePositions) this.order.splice(p, 1);
        this.rebuildPositions();
        this.renumber();
      }
    }

    if (mounted.length === 0) return stats;

    // 1. 内容の取り込み（追加・更新・再活性化）
    for (const incoming of mounted) {
      const existing = this.byKey.get(incoming.messageKey);
      if (existing) {
        if (existing.contentHash !== incoming.contentHash) {
          existing.role = incoming.role;
          existing.speaker = incoming.speaker;
          existing.parts = incoming.parts;
          existing.contentHash = incoming.contentHash;
          existing.updatedAt = incoming.updatedAt;
          this.dirtyKeys.add(existing.messageKey);
          stats.updated++;
        } else {
          stats.unchanged++;
        }
        if (!existing.active) {
          existing.active = true;
          this.dirtyKeys.add(existing.messageKey);
        }
      } else {
        this.byKey.set(incoming.messageKey, {
          ...incoming,
          active: true,
          parts: incoming.parts.map((p) => ({ ...p })),
        });
        this.dirtyKeys.add(incoming.messageKey);
        stats.added++;
      }
    }

    // 2. 順序リストへの接合
    const mountedKeys = mounted.map((m) => m.messageKey);
    if (this.order.length === 0) {
      this.order = [...mountedKeys];
    } else {
      const anchorPositions: number[] = [];
      for (const key of mountedKeys) {
        const p = this.pos.get(key);
        if (p !== undefined) anchorPositions.push(p);
      }

      if (anchorPositions.length === 0) {
        // 同期中は上→下の遭遇順、それ以外は範囲全体の挿入位置だけを推定。
        // 画面で確認できたウィンドウ内部の順序は決して ID 順に並べ替えない。
        if (this.rebuildBackup !== null || options.atBottom) {
          this.order.push(...mountedKeys);
        } else {
          const previousPositions = this.lastWindow.flatMap((key) => {
            const position = this.pos.get(key);
            return position === undefined ? [] : [position];
          });
          if (options.scrollDirection && previousPositions.length > 0) {
            const insertAt = options.scrollDirection === "older"
              ? Math.min(...previousPositions)
              : Math.max(...previousPositions) + 1;
            this.order.splice(insertAt, 0, ...mountedKeys);
          } else {
            this.insertDisjoint(mountedKeys);
          }
        }
      } else {
        let start = Math.min(...anchorPositions);
        let end = Math.max(...anchorPositions);

        if (options.atBottom) {
          // 最下部での取得: 最後のアンカー以降に残る未マウント既知メッセージは
          // 再生成等で消えたとみなす
          end = this.order.length - 1;
        }

        // 連続性: [start..end] 内でマウントされていない既知 key は消滅と判断
        const mountedSet = new Set(mountedKeys);
        for (let i = start; i <= end; i++) {
          const key = this.order[i];
          if (!mountedSet.has(key)) {
            const rec = this.byKey.get(key);
            if (rec && rec.active) {
              rec.active = false;
              this.dirtyKeys.add(key);
              stats.deactivated++;
            }
          }
        }
        this.order.splice(start, end - start + 1, ...mountedKeys);
      }
    }

    this.rebuildPositions();
    this.renumber();
    this.lastWindow = mountedKeys;
    return stats;
  }

  /**
   * Full Sync の上→下パス開始時に呼ぶ。順序リストを空にして
   * パス中の mergeWindow が純粋な遭遇順で再構築できるようにする。
   * メッセージ本体 (byKey) は保持する。
   */
  beginRebuild(): void {
    if (this.rebuildBackup !== null) return;
    this.rebuildBackup = this.order;
    this.lastWindow = [];
    this.order = [];
    this.rebuildPositions();
  }

  /**
   * Full Sync 終了時（中断時も必ず）に呼ぶ。
   * パス中に遭遇しなかった active な既知メッセージ
   * を旧順序の隣接アンカーに沿って戻す。ID の大小は使用しない。
   */
  finishRebuild(): void {
    this.lastWindow = [];
    const backup = this.rebuildBackup;
    if (backup === null) return;
    this.rebuildBackup = null;

    let pending: string[] = [];
    let previousAnchor: string | null = null;
    for (const key of backup) {
      if (!this.byKey.get(key)?.active) continue;
      const position = this.pos.get(key);
      if (position === undefined) {
        pending.push(key);
        continue;
      }
      if (pending.length > 0) {
        this.order.splice(position, 0, ...pending);
        this.rebuildPositions();
        pending = [];
      }
      previousAnchor = key;
    }
    if (pending.length > 0) {
      // 共通アンカーがない未走査の旧履歴は、一続きの範囲として先頭へ保持。
      const insertAt = previousAnchor === null
        ? 0
        : this.pos.get(previousAnchor)! + 1;
      this.order.splice(insertAt, 0, ...pending);
    }

    this.rebuildPositions();
    this.renumber();
  }

  /** active なメッセージを時系列順で返す。 */
  getActiveSorted(): MessageRecord[] {
    const out: MessageRecord[] = [];
    for (const key of this.order) {
      const rec = this.byKey.get(key);
      if (rec && rec.active) out.push(rec);
    }
    return out;
  }

  /** 前回 drain 以降に追加・更新・番号変更・無効化されたレコードを返す。 */
  drainDirty(): MessageRecord[] {
    const out: MessageRecord[] = [];
    for (const key of this.dirtyKeys) {
      const rec = this.byKey.get(key);
      if (rec) out.push({ ...rec, parts: rec.parts.map((p) => ({ ...p })) });
    }
    this.dirtyKeys.clear();
    return out;
  }

  /** 送信失敗時に dirty へ戻す。 */
  markDirty(records: MessageRecord[]): void {
    for (const rec of records) {
      if (this.byKey.has(rec.messageKey)) this.dirtyKeys.add(rec.messageKey);
    }
  }

  hasDirty(): boolean {
    return this.dirtyKeys.size > 0;
  }

  get size(): number {
    return this.byKey.size;
  }

  get activeCount(): number {
    return this.order.length;
  }

  clear(): void {
    this.lastWindow = [];
    this.byKey.clear();
    this.order = [];
    this.pos.clear();
    this.dirtyKeys.clear();
    this.rebuildBackup = null;
  }

  /* ------------------------------------------------------------------ */

  private rebuildPositions(): void {
    this.pos.clear();
    for (let i = 0; i < this.order.length; i++) {
      this.pos.set(this.order[i], i);
    }
  }

  /** order 上の位置 (1-based) を index として振り直す。変更分は dirty。 */
  private renumber(): void {
    for (let i = 0; i < this.order.length; i++) {
      const rec = this.byKey.get(this.order[i]);
      if (!rec) continue;
      const next = i + 1;
      if (rec.index !== next) {
        rec.index = next;
        this.dirtyKeys.add(rec.messageKey);
      }
    }
  }

  private insertDisjoint(mountedKeys: string[]): void {
    // アンカーも走査方向もない場合のみ ID で境界を推定する。
    // 確認済みの範囲内の前後関係は保持する。
    const myId = numericIdOf(mountedKeys[0]);
    let insertAt = this.order.length;
    if (myId !== null) {
      for (let i = 0; i < this.order.length; i++) {
        const otherId = numericIdOf(this.order[i]);
        if (otherId !== null && compareNumericIds(otherId, myId) > 0) {
          insertAt = i;
          break;
        }
      }
    }
    this.order.splice(insertAt, 0, ...mountedKeys);
  }
}

/** "message-MESSAGE-8212077265438-bscW" → "8212077265438" */
export function numericIdOf(messageKey: string): string | null {
  const m = /(\d{6,})/.exec(messageKey);
  return m ? m[1] : null;
}

export function compareNumericIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}
