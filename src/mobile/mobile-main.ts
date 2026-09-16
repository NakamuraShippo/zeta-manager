/**
 * zeta-manager — iOS Safari 向けユーザースクリプト版エントリ。
 *
 * Chrome 拡張 API を一切使わず、ページ内で完結する:
 * - 取得ロジック（zeta-adapter / capture-window / conversation-capture /
 *   full-sync）はデスクトップ版 content script と共有
 * - 保存はページ origin の IndexedDB（ArchiveRepository をそのまま使用）
 * - UI は左下のフローティングボタン + シート（mobile-panel）
 * - LLM 要約は含まない（取得・全履歴同期・コピー・自動保存のみ）
 *
 * 「Userscripts」等の Safari 用ユーザースクリプトマネージャに読み込むか、
 * ブックマークレットとして実行する。
 */

import { ConversationStore } from "../content/conversation-capture";
import { startLorebookImporter } from "../lorebook/importer";
import { captureVisibleWindow } from "../content/capture-window";
import { batchLiveUpdates, CaptureScrollTracker, PassiveCapture } from "../content/passive-capture";
import {
  findLogContainer,
  findMessageNodes,
  getPlotName,
  getRoomId,
} from "../content/zeta-adapter";
import { findScrollContainer, isNearBottom, runFullSync } from "../content/full-sync";
import { openDatabase } from "../storage/database";
import { ArchiveRepository } from "../storage/archive-repository";
import { DEFAULT_FORMAT_OPTIONS, formatTranscript } from "../shared/text-format";
import { countChars, debounce, formatDateLocal } from "../shared/utils";
import type { RoomInfo } from "../shared/types";
import { MOBILE_HOST_ID, MobilePanel } from "./mobile-panel";

declare global {
  interface Window {
    __zetaLogCompanionMobileLoaded?: boolean;
  }
}

const ROUTE_POLL_MS = 1000;
const CONTAINER_POLL_MS = 500;
const CONTAINER_POLL_LIMIT = 40; // 20秒
const AUTO_SAVE_DEBOUNCE_MS = 2000;

class MobileApp {
  private readonly store = new ConversationStore();
  private readonly repo = new ArchiveRepository(openDatabase());
  private panel!: MobilePanel;

  private currentRoomId: string | null = null;
  private plotName: string | null = null;
  private liveText = "";

  private passiveCapture: PassiveCapture | null = null;
  private readonly scrollTracker = new CaptureScrollTracker();
  private lastCaptureSignature = "";
  private containerPollTimer: number | null = null;
  private containerPollCount = 0;
  private fullSyncRunning = false;

  private readonly scheduleLiveUpdate = batchLiveUpdates(() => this.updatePanelLive());

  /** IndexedDB が使えない環境（プライベートブラウズ等）では false に落とす */
  private storageAvailable = true;

  private readonly scheduleSave = debounce(
    () => void this.persist(),
    AUTO_SAVE_DEBOUNCE_MS,
  );

  start(): void {
    this.panel = new MobilePanel({
      getLiveText: () => this.liveText,
      requestFullSync: () => void this.runFullSyncFlow(),
    });
    this.panel.mount();

    window.setInterval(() => this.handleRouteChange(), ROUTE_POLL_MS);
    window.addEventListener("popstate", () => this.handleRouteChange());

    const flush = () => {
      if (this.store.hasDirty()) this.scheduleSave.flush();
    };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
    window.addEventListener("pagehide", flush);

    this.handleRouteChange();
  }

  /* ------------------------------------------------------------------ */
  /* Room lifecycle                                                      */

  private handleRouteChange(): void {
    const roomId = getRoomId(location.pathname);
    if (roomId === this.currentRoomId) return;

    this.teardownRoom();
    this.currentRoomId = roomId;
    this.panel.setVisible(roomId !== null);
    if (roomId) this.initRoom();
  }

  private teardownRoom(): void {
    this.passiveCapture?.stop();
    this.passiveCapture = null;
    this.scrollTracker.reset();
    this.lastCaptureSignature = "";
    this.scheduleLiveUpdate.cancel();
    if (this.containerPollTimer !== null) {
      window.clearTimeout(this.containerPollTimer);
      this.containerPollTimer = null;
    }
    this.containerPollCount = 0;

    if (this.currentRoomId && this.store.hasDirty()) {
      this.scheduleSave.flush();
    }
    this.scheduleSave.cancel();

    this.store.clear();
    this.plotName = null;
    this.liveText = "";
    if (this.panel) {
      this.panel.setPlotName(null);
      this.panel.updateLive(0, 0, "");
      this.panel.setLastSaved(null);
      this.panel.setSyncProgress(null);
      this.panel.setStatus("");
    }
  }

  private initRoom(): void {
    this.containerPollCount = 0;
    const poll = () => {
      this.containerPollTimer = null;
      if (!this.currentRoomId) return;

      const container = findLogContainer();
      if (container) {
        void this.attachToRoom(container);
        return;
      }
      this.containerPollCount++;
      if (this.containerPollCount >= CONTAINER_POLL_LIMIT) {
        this.panel.setStatus("Zeta conversation not detected", "error");
        return;
      }
      this.containerPollTimer = window.setTimeout(poll, CONTAINER_POLL_MS);
    };
    poll();
  }

  private async attachToRoom(container: HTMLElement): Promise<void> {
    const roomId = this.currentRoomId;
    if (!roomId) return;

    // 前回保存分で順序リストを初期化（保存不可環境ならそのまま続行）
    try {
      const seeded = await this.repo.getActiveMessages(roomId);
      if (this.currentRoomId !== roomId) return;
      if (seeded.length > 0) this.store.seed(seeded);
    } catch {
      this.storageAvailable = false;
      this.panel.setSaveAvailable(false);
    }

    this.scanAndUpdate();
    if (this.store.hasDirty()) this.scheduleSave();

    this.passiveCapture = new PassiveCapture(container, () => {
      if (this.fullSyncRunning) return;
      this.scanAndUpdate();
      if (this.store.hasDirty()) this.scheduleSave();
    });
  }

  /* ------------------------------------------------------------------ */
  /* capture                                                             */

  private captureAndMerge(roomId: string): number {
    if (this.currentRoomId !== roomId) return this.store.activeCount;

    const name = getPlotName();
    if (name) this.plotName = name;

    const nodeCount = findMessageNodes().length;
    const { records, displaced } = captureVisibleWindow(roomId);

    if (nodeCount > 0 && records.length === 0 && displaced.length === 0) {
      this.panel.setStatus(
        "Zetaのページ構造が変更された可能性があります。",
        "error",
      );
    }

    if (records.length > 0 || displaced.length > 0) {
      const log = findLogContainer();
      const scroll = log ? findScrollContainer(log) : null;
      const atBottom = scroll ? isNearBottom(scroll) : false;
      const scrollDirection = scroll && !this.fullSyncRunning
        ? this.scrollTracker.observe(scroll, records.map((r) => r.messageKey)) : undefined;
      const signature = JSON.stringify([
        records.map((r) => [r.messageKey, r.contentHash]),
        displaced.map((r) => [r.messageKey, r.contentHash]), atBottom,
      ]);
      if (signature === this.lastCaptureSignature) return this.store.activeCount;
      this.lastCaptureSignature = signature;
      this.store.mergeWindow(records, { atBottom, displaced, scrollDirection });
    }

    if (!this.fullSyncRunning) this.scheduleLiveUpdate();
    return this.store.activeCount;
  }

  private scanAndUpdate(): number {
    const roomId = this.currentRoomId;
    if (!roomId) return 0;
    if (this.fullSyncRunning) return this.store.activeCount;
    return this.captureAndMerge(roomId);
  }

  private updatePanelLive(): void {
    const active = this.store.getActiveSorted();
    const text = formatTranscript(active, DEFAULT_FORMAT_OPTIONS);
    this.panel.setPlotName(this.plotName);
    if (text !== this.liveText) {
      this.liveText = text;
      this.panel.updateLive(active.length, countChars(text), text);
    }
  }

  /* ------------------------------------------------------------------ */
  /* save                                                                */

  private async persist(): Promise<void> {
    const roomId = this.currentRoomId;
    if (!roomId || !this.storageAvailable) return;

    const room: RoomInfo = {
      roomId,
      plotName: this.plotName ?? "",
      url: location.origin + location.pathname,
    };

    const dirty = this.store.drainDirty();
    if (dirty.length === 0) return;

    try {
      const now = Date.now();
      await this.repo.upsertRoom(room, now);
      await this.repo.upsertMessages(roomId, dirty);
      const snapshot = await this.repo.saveSnapshot(
        room,
        formatDateLocal(now),
        DEFAULT_FORMAT_OPTIONS,
        now,
      );
      if (snapshot) this.panel.setLastSaved(now);
    } catch {
      this.store.markDirty(dirty);
      this.storageAvailable = false;
      this.panel.setSaveAvailable(false);
      this.panel.setStatus(
        "この環境では保存できません（コピーは使用できます）",
        "error",
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /* Full Sync                                                           */

  private async runFullSyncFlow(): Promise<void> {
    if (this.fullSyncRunning) return;
    const roomAtStart = this.currentRoomId;
    if (!roomAtStart) return;

    const log = findLogContainer();
    if (!log) {
      this.panel.setStatus("Zeta conversation not detected", "error");
      return;
    }

    this.fullSyncRunning = true;
    this.lastCaptureSignature = "";
    this.scheduleLiveUpdate.cancel();
    this.scrollTracker.reset();
    this.store.beginRebuild();
    this.panel.setSyncProgress("履歴同期を開始…");
    this.panel.setStatus("");

    let result: { aborted: boolean; collectedMessages: number } | null = null;
    try {
      result = await runFullSync({
        container: findScrollContainer(log),
        collect: () => this.captureAndMerge(roomAtStart),
        onProgress: (p) => {
          if (p.phase === "loading") {
            this.panel.setSyncProgress(`過去ログを読み込み中… (${p.steps})`);
          } else if (p.phase === "scanning") {
            this.panel.setSyncProgress(
              `履歴取得中… ${p.collectedMessages} messages`,
            );
          } else if (p.phase === "restoring") {
            this.panel.setSyncProgress("スクロール位置を復元中…");
          }
        },
        shouldAbort: () => this.currentRoomId !== roomAtStart,
      });
    } finally {
      this.store.finishRebuild();
      this.fullSyncRunning = false;
      this.lastCaptureSignature = "";
      this.panel.setSyncProgress(null);
      this.updatePanelLive();
    }

    if (result === null) {
      this.panel.setStatus("同期中にエラーが発生しました", "error");
      return;
    }
    if (result.aborted) {
      this.panel.setStatus("同期は未完了です（中断・走査上限・取得エラー）。取得済みのログは保持しました。", "error");
    } else {
      this.panel.setStatus(
        `同期完了: ${result.collectedMessages} messages 取得`,
        "ok",
      );
    }
    if (this.currentRoomId === roomAtStart && this.store.hasDirty()) {
      await this.persist();
    }
  }
}

(() => {
  // 二重実行防止（ユーザースクリプト + ブックマークレットの併用等）
  if (window.__zetaLogCompanionMobileLoaded) return;
  if (document.getElementById(MOBILE_HOST_ID)) return;
  window.__zetaLogCompanionMobileLoaded = true;

  const boot = () => {
    startLorebookImporter();
    const app = new MobileApp();
    app.start();
  };
  if (document.readyState === "complete") {
    boot();
  } else {
    window.addEventListener("load", boot, { once: true });
  }
})();
