/**
 * content script エントリポイント (§26)。
 * - Room 検出 / SPA 遷移監視 (§13)
 * - DOM 解析 + MutationObserver による Passive Capture (§10 / §11)
 * - Full Sync の起動 (§10)
 * - Shadow DOM パネルの表示
 * - service worker との通信（LLM API キーや DB 実装は持たない）
 */

import { ConversationStore } from "./conversation-capture";
import { startLorebookImporter } from "../lorebook/importer";
import { captureVisibleWindow } from "./capture-window";
import { batchLiveUpdates, CaptureScrollTracker, PassiveCapture } from "./passive-capture";
import {
  findLogContainer,
  findMessageNodes,
  getPlotName,
  getRoomId,
} from "./zeta-adapter";
import { findScrollContainer, isNearBottom, runFullSync } from "./full-sync";
import { HOST_ID, ZlcPanel } from "./panel";
import {
  sendToBackground,
  type BackgroundPush,
  type SaveSnapshotResult,
  type SettingsResult,
} from "../shared/messages";
import { formatTranscript } from "../shared/text-format";
import { countChars, debounce } from "../shared/utils";
import {
  defaultSettings,
  type MessageRecord,
  type RoomInfo,
  type Settings,
} from "../shared/types";

declare global {
  interface Window {
    __zetaLogCompanionLoaded?: boolean;
  }
}

const ROUTE_POLL_MS = 1000;
const CONTAINER_POLL_MS = 500;
const CONTAINER_POLL_LIMIT = 40; // 20秒

class App {
  private settings: Settings = defaultSettings();
  private panel!: ZlcPanel;
  private readonly store = new ConversationStore();

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

  private scheduleSave = debounce(() => void this.persist(false), 2000);

  async start(): Promise<void> {
    const res = await sendToBackground<SettingsResult>({ type: "GET_SETTINGS" });
    const initial: SettingsResult = res.ok
      ? res.data
      : { settings: defaultSettings(), hasApiKey: false };
    this.settings = initial.settings;
    this.scheduleSave = debounce(
      () => void this.persist(false),
      this.settings.autoSaveDebounceMs,
    );

    this.panel = new ZlcPanel({
      getLiveText: () => this.liveText,
      getRoomContext: () => ({
        roomId: this.currentRoomId,
        plotName: this.plotName,
      }),
      requestFullSync: () => void this.runFullSyncFlow(),
      requestSaveNow: () => void this.persist(true),
      onSettingsApplied: (settings) => this.applySettings(settings),
    });
    this.panel.mount(initial);

    // service worker からの進捗プッシュ (要約中の表示)
    chrome.runtime.onMessage.addListener((message: BackgroundPush) => {
      if (message && message.type === "SUMMARY_PROGRESS") {
        this.panel.setSummaryProgress(message.message);
      }
    });

    // SPA の Room 遷移監視 (§13)。history API は page 側 world のため polling で検出する。
    window.setInterval(() => this.handleRouteChange(), ROUTE_POLL_MS);
    window.addEventListener("popstate", () => this.handleRouteChange());

    // タブが隠れる/閉じる前に未保存分を書き出す
    const flush = () => {
      if (this.store.hasDirty()) this.scheduleSave.flush();
    };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
    window.addEventListener("pagehide", flush);

    this.handleRouteChange();
  }

  private applySettings(settings: Settings): void {
    this.settings = settings;
    this.scheduleSave.cancel();
    this.scheduleSave = debounce(
      () => void this.persist(false),
      settings.autoSaveDebounceMs,
    );
    // フォーマット設定変更を LIVE 表示へ即時反映
    this.updatePanelLive();
  }

  /* ------------------------------------------------------------------ */
  /* Room lifecycle (§13)                                                */

  private handleRouteChange(): void {
    const roomId = getRoomId(location.pathname);
    if (roomId === this.currentRoomId) return;

    this.teardownRoom();
    this.currentRoomId = roomId;

    if (roomId) {
      this.panel.setVisible(true);
      this.panel.showGlobalStatus(null);
      this.initRoom();
    } else {
      this.panel.setVisible(false);
    }
  }

  private teardownRoom(): void {
    // 1. Observer 解除 → 2. 現 Room 保存 → 3. Map クリア (§13)
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
        this.panel.showGlobalStatus("Zeta conversation not detected", "error");
        return;
      }
      this.containerPollTimer = window.setTimeout(poll, CONTAINER_POLL_MS);
    };
    poll();
  }

  private async attachToRoom(container: HTMLElement): Promise<void> {
    const roomId = this.currentRoomId;
    if (!roomId) return;

    // 前セッションで保存済みのメッセージを読み込み、順序リストの土台にする
    // （リロード後も時系列と重複排除が安定する §39-7/8）
    const seeded = await sendToBackground<MessageRecord[]>({
      type: "GET_ROOM_MESSAGES",
      roomId,
    });
    if (this.currentRoomId !== roomId) return; // 待機中に Room が変わった
    if (seeded.ok && seeded.data.length > 0) {
      this.store.seed(seeded.data);
    }

    this.panel.showGlobalStatus(null);
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

  /** 現在のウィンドウをストアへ接合する共通処理。時系列リストの件数を返す。 */
  private captureAndMerge(roomId: string): number {
    // Room 遷移後に旧 Room ID で新 Room の DOM を取り込まない
    if (this.currentRoomId !== roomId) return this.store.activeCount;

    const name = getPlotName();
    if (name) this.plotName = name;

    const nodeCount = findMessageNodes().length;
    const { records, displaced } = captureVisibleWindow(roomId);

    // selector が壊れた場合の検知 (§34)
    if (nodeCount > 0 && records.length === 0 && displaced.length === 0) {
      this.panel.showGlobalStatus(
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

    // 取得は毎フレーム可能にし、長い全文の整形と描画はまとめて行う。
    // 全履歴同期中は件数の進捗だけを更新し、全文の整形は終了時に一度行う。
    if (!this.fullSyncRunning) this.scheduleLiveUpdate();
    return this.store.activeCount;
  }

  /** Passive Capture。Full Sync 中は同期側の collect に任せて何もしない。 */
  private scanAndUpdate(): number {
    const roomId = this.currentRoomId;
    if (!roomId) return 0;
    if (this.fullSyncRunning) return this.store.activeCount;
    return this.captureAndMerge(roomId);
  }

  private updatePanelLive(): void {
    const active = this.store.getActiveSorted();
    const text = formatTranscript(active, this.settings.format);
    this.panel.setPlotName(this.plotName);
    if (text !== this.liveText) {
      this.liveText = text;
      this.panel.updateLive(active.length, countChars(text), text);
    }
  }

  /* ------------------------------------------------------------------ */
  /* save (§14)                                                          */

  private async persist(force: boolean): Promise<void> {
    const roomId = this.currentRoomId;
    if (!roomId) return;
    if (!this.settings.autoSaveEnabled && !force) return;

    const room: RoomInfo = {
      roomId,
      plotName: this.plotName ?? "",
      url: location.origin + location.pathname,
    };

    const dirty = this.store.drainDirty();
    if (dirty.length > 0) {
      const res = await sendToBackground({
        type: "UPSERT_MESSAGES",
        room,
        records: dirty,
      });
      if (!res.ok) {
        this.store.markDirty(dirty);
        this.panel.setLiveStatus(`保存失敗: ${res.error}`, "error");
        return;
      }
    }

    if (dirty.length > 0 || force) {
      const res = await sendToBackground<SaveSnapshotResult>({
        type: "SAVE_SNAPSHOT",
        room,
      });
      if (res.ok) {
        this.panel.setLastSaved(res.data);
        if (force) this.panel.setLiveStatus("保存しました", "ok");
      } else if (force) {
        this.panel.setLiveStatus(`保存失敗: ${res.error}`, "error");
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Full Sync (§10)                                                     */

  private async runFullSyncFlow(): Promise<void> {
    if (this.fullSyncRunning) return;
    const roomAtStart = this.currentRoomId;
    if (!roomAtStart) return;

    const log = findLogContainer();
    if (!log) {
      this.panel.setLiveStatus("Zeta conversation not detected", "error");
      return;
    }

    this.fullSyncRunning = true;
    this.lastCaptureSignature = "";
    this.scheduleLiveUpdate.cancel();
    this.scrollTracker.reset();
    // 上→下パスの遭遇順で順序リストを作り直す（未走査分は finishRebuild が戻す）
    this.store.beginRebuild();
    this.panel.setSyncProgress("履歴同期を開始…");

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
      this.panel.setLiveStatus("同期中にエラーが発生しました", "error");
      return;
    }
    if (result.aborted) {
      this.panel.setLiveStatus("同期は未完了です（中断・走査上限・取得エラー）。取得済みのログは保持しました。", "error");
    } else {
      this.panel.setLiveStatus(
        `同期完了: ${result.collectedMessages} messages 取得`,
        "ok",
      );
    }
    if (this.currentRoomId === roomAtStart) {
      await this.persist(true);
    }
  }
}

(() => {
  // 同一ページへの二重 inject 防止 (§13)
  if (window.__zetaLogCompanionLoaded) return;
  if (document.getElementById(HOST_ID)) return;
  window.__zetaLogCompanionLoaded = true;

  // Next.js の hydration が終わる前に DOM へ触れない（load 完了後に起動）
  const boot = () => {
    startLorebookImporter();
    const app = new App();
    void app.start();
  };
  if (document.readyState === "complete") {
    boot();
  } else {
    window.addEventListener("load", boot, { once: true });
  }
})();
