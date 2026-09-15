/**
 * 右側固定ペイン (§17-§19)。
 * - Shadow DOM で Zeta 側 CSS との干渉を避ける
 * - 会話本文・LLM 出力は必ず textContent / value で描画する (§35)
 * - Dock 時は #contents を CSS で縮めるだけで、Zeta の DOM は変更しない (§18)
 */

import panelCss from "./panel.css";
import {
  sendToBackground,
  type ArchiveDetail,
  type SaveSnapshotResult,
  type SettingsResult,
  type SummarizeResult,
  type SummaryInput,
  type TestConnectionResult,
} from "../shared/messages";
import {
  OVERLAY_VIEWPORT_THRESHOLD,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  type Settings,
  type SnapshotRecord,
} from "../shared/types";
import { formatTimeLocal, isLocalEndpoint } from "../shared/utils";

export const HOST_ID = "zeta-log-companion-host";
const DOCK_STYLE_ID = "zeta-log-companion-dock-style";

export interface PanelHost {
  getLiveText(): string;
  getRoomContext(): { roomId: string | null; plotName: string | null };
  requestFullSync(): void;
  requestSaveNow(): void;
  /** SETTINGS 保存後、content 側で反映すべき値（debounce 等）を通知する */
  onSettingsApplied(settings: Settings): void;
}

type SummarySource =
  | { kind: "live" }
  | { kind: "archive"; snapshotId: string; label: string; text: string };

interface LastSummaryContext {
  result: SummarizeResult;
  sourceLabel: string;
  roomId: string | null;
  snapshotId: string | null;
  targetChars: number;
}

/* 静的テンプレート。動的な値は一切埋め込まない（XSS 対策 §35）。 */
const TEMPLATE = `
<div class="zlc-root">
  <div class="zlc-resize-handle" data-el="resizeHandle" title="ドラッグで幅を変更"></div>

  <div class="zlc-expand-strip">
    <button class="zlc-icon-btn" data-el="btnExpand" title="展開">◀</button>
    <div class="vertical-label">ZETA LOG</div>
  </div>

  <header class="zlc-header">
    <div class="zlc-title">Zeta Log Companion</div>
    <button class="zlc-icon-btn" data-el="btnCollapse" title="折りたたむ">▶</button>
  </header>

  <div class="zlc-global-status" data-el="globalStatus" hidden></div>

  <nav class="zlc-tabs">
    <button data-tab="live" class="active">LIVE</button>
    <button data-tab="archives">ARCHIVES</button>
    <button data-tab="summary">SUMMARY</button>
    <button data-tab="settings">SETTINGS</button>
  </nav>

  <section class="zlc-panel" data-panel="live">
    <div class="zlc-plot-name" data-el="plotName">—</div>
    <div class="zlc-live-stats">
      <span data-el="liveMessages">0 messages</span> ・
      <span data-el="liveChars">0 characters</span>
    </div>
    <div class="zlc-save-row">
      <span class="zlc-badge" data-el="autoSaveBadge">● Auto Save</span>
      <span data-el="lastSaved">未保存</span>
    </div>
    <div class="zlc-sync-progress" data-el="syncProgress" hidden></div>
    <div class="zlc-btn-row">
      <button class="zlc-btn primary" data-el="btnFullSync">全履歴を同期</button>
      <button class="zlc-btn" data-el="btnSaveNow">今すぐ保存</button>
      <button class="zlc-btn" data-el="btnCopyLive">コピー</button>
    </div>
    <div class="zlc-status-line" data-el="liveStatus"></div>
    <textarea class="zlc-textarea" data-el="liveText" readonly spellcheck="false"></textarea>
  </section>

  <section class="zlc-panel" data-panel="archives" hidden>
    <div data-el="archiveListView">
      <div class="zlc-btn-row" style="margin-bottom:8px">
        <button class="zlc-btn" data-el="btnReloadArchives">再読み込み</button>
      </div>
      <div class="zlc-status-line" data-el="archivesStatus"></div>
      <div data-el="archivesList" style="display:flex;flex-direction:column;gap:8px"></div>
    </div>
    <div data-el="archiveDetailView" hidden style="display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-height:0">
      <div class="zlc-btn-row">
        <button class="zlc-btn" data-el="btnArchiveBack">← 一覧へ</button>
      </div>
      <div class="zlc-plot-name" data-el="archiveTitle"></div>
      <div class="zlc-detail-meta" data-el="archiveMeta"></div>
      <div class="zlc-btn-row">
        <button class="zlc-btn" data-el="btnArchiveCopy">コピー</button>
        <button class="zlc-btn" data-el="btnArchiveSummarize">要約</button>
        <button class="zlc-btn danger" data-el="btnArchiveDelete">削除</button>
      </div>
      <div class="zlc-status-line" data-el="archiveDetailStatus"></div>
      <textarea class="zlc-textarea" data-el="archiveText" readonly spellcheck="false"></textarea>
      <div class="zlc-section-title" data-el="archiveSummariesTitle" hidden>保存済み要約</div>
      <div data-el="archiveSummaries" style="display:flex;flex-direction:column;gap:6px"></div>
    </div>
  </section>

  <section class="zlc-panel" data-panel="summary" hidden>
    <div class="zlc-field">
      <label>Source</label>
      <select data-el="summarySource"></select>
    </div>
    <div class="zlc-row">
      <div class="zlc-field">
        <label>Target characters</label>
        <input type="number" data-el="summaryTarget" min="100" step="100" />
      </div>
    </div>
    <div class="zlc-field">
      <label>Provider</label>
      <div class="zlc-result-meta">
        <span data-el="summaryProviderName"></span>
        <span class="zlc-badge" data-el="summaryEndpointBadge"></span>
      </div>
      <div class="zlc-note" data-el="summaryProviderDetail"></div>
    </div>
    <div class="zlc-btn-row">
      <button class="zlc-btn primary" data-el="btnSummarize">要約する</button>
    </div>
    <div class="zlc-confirm" data-el="remoteConfirm" hidden>
      <div>この会話ログは設定された外部LLMサービスへ送信されます。</div>
      <div>送信先: <span class="dest" data-el="remoteConfirmDest"></span></div>
      <div>続行しますか？</div>
      <div class="zlc-btn-row">
        <button class="zlc-btn primary" data-el="btnRemoteProceed">続行する</button>
        <button class="zlc-btn" data-el="btnRemoteCancel">キャンセル</button>
      </div>
    </div>
    <div class="zlc-btn-row" data-el="permissionActions" hidden>
      <button class="zlc-btn" data-el="btnOpenOptionsFromSummary">権限設定ページを開く</button>
    </div>
    <div class="zlc-status-line" data-el="summaryStatus"></div>
    <div data-el="summaryResultBlock" hidden style="display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-height:0">
      <hr class="zlc-hr" />
      <div class="zlc-result-meta">
        <span>Result</span>
        <span data-el="summaryResultChars"></span>
      </div>
      <div class="zlc-btn-row">
        <button class="zlc-btn" data-el="btnCopySummary">コピー</button>
        <button class="zlc-btn" data-el="btnSaveSummary">保存</button>
        <button class="zlc-btn" data-el="btnRegenerate">再生成</button>
      </div>
      <textarea class="zlc-textarea" data-el="summaryText" readonly spellcheck="false"></textarea>
    </div>
  </section>

  <section class="zlc-panel" data-panel="settings" hidden>
    <label class="zlc-check">
      <input type="checkbox" data-el="setAutoSave" /> Auto Save を有効にする
    </label>
    <div class="zlc-row">
      <div class="zlc-field">
        <label>Auto Save Debounce (ms)</label>
        <input type="number" data-el="setDebounce" min="500" step="100" />
      </div>
      <div class="zlc-field">
        <label>Default summary length</label>
        <input type="number" data-el="setTargetChars" min="100" step="100" />
      </div>
    </div>
    <div class="zlc-row">
      <div class="zlc-field">
        <label>Panel width (px)</label>
        <input type="number" data-el="setPanelWidth" min="320" max="700" step="10" />
      </div>
      <div class="zlc-field">
        <label>分割要約の最大入力文字数</label>
        <input type="number" data-el="setMaxInput" min="2000" step="1000" />
      </div>
    </div>
    <div class="zlc-field">
      <label>表示モード</label>
      <select data-el="setLayoutMode">
        <option value="overlay">Overlay（既定・Zetaのレイアウトに影響しない）</option>
        <option value="dock">Dock（実験的・#contents をペイン幅ぶん縮める）</option>
      </select>
      <div class="zlc-note">Dock で表示が崩れる場合は Overlay に戻してページを再読み込みしてください</div>
    </div>
    <label class="zlc-check">
      <input type="checkbox" data-el="setSpeakerLabels" /> 話者ラベルを付ける
    </label>
    <label class="zlc-check">
      <input type="checkbox" data-el="setNarrationLabels" /> ナレーションラベルを付ける
    </label>

    <hr class="zlc-hr" />
    <div class="zlc-section-title">LLM PROVIDER</div>
    <div class="zlc-field">
      <label>Provider</label>
      <select data-el="setProvider">
        <option value="openai-compatible">OpenAI Compatible (LM Studio / llama.cpp 等)</option>
        <option value="generic-json">Generic JSON HTTP</option>
      </select>
    </div>

    <div data-el="openaiFields" style="display:flex;flex-direction:column;gap:10px">
      <div class="zlc-field">
        <label>Endpoint</label>
        <input type="text" data-el="setOaiEndpoint" placeholder="http://127.0.0.1:1234/v1/chat/completions" spellcheck="false" />
      </div>
      <div class="zlc-row">
        <div class="zlc-field">
          <label>Model</label>
          <input type="text" data-el="setOaiModel" spellcheck="false" />
        </div>
        <div class="zlc-field">
          <label>Temperature</label>
          <input type="number" data-el="setOaiTemperature" min="0" max="2" step="0.1" />
        </div>
      </div>
    </div>

    <div data-el="genericFields" hidden style="display:flex;flex-direction:column;gap:10px">
      <div class="zlc-field">
        <label>URL</label>
        <input type="text" data-el="setGjUrl" spellcheck="false" />
      </div>
      <div class="zlc-field">
        <label>HTTP Method</label>
        <select data-el="setGjMethod">
          <option value="POST">POST</option>
          <option value="PUT">PUT</option>
          <option value="GET">GET</option>
        </select>
      </div>
      <div class="zlc-field">
        <label>Headers (JSON)</label>
        <textarea data-el="setGjHeaders" rows="3" spellcheck="false"></textarea>
        <div class="zlc-note">値には {{apiKey}} を使用できます</div>
      </div>
      <div class="zlc-field">
        <label>JSON Request Template</label>
        <textarea data-el="setGjTemplate" rows="6" spellcheck="false"></textarea>
        <div class="zlc-note">{{text}} {{targetChars}} {{instruction}} {{model}} {{apiKey}} を置換します</div>
      </div>
      <div class="zlc-field">
        <label>Response JSON Path</label>
        <input type="text" data-el="setGjPath" placeholder="result.text" spellcheck="false" />
      </div>
    </div>

    <div class="zlc-field">
      <label>API Key</label>
      <input type="password" data-el="setApiKey" autocomplete="off" spellcheck="false" />
      <div class="zlc-note" data-el="apiKeyHint"></div>
      <div class="zlc-btn-row">
        <button class="zlc-btn danger" data-el="btnClearApiKey">APIキーを削除</button>
      </div>
    </div>
    <label class="zlc-check">
      <input type="checkbox" data-el="setRememberKey" /> APIキーを保存する（永続化）
    </label>
    <div class="zlc-note">オフの場合、APIキーはブラウザ終了時に破棄されます (session storage)</div>

    <hr class="zlc-hr" />
    <div class="zlc-field">
      <label>Summary instruction</label>
      <textarea data-el="setInstruction" rows="10" spellcheck="false"></textarea>
      <div class="zlc-note">{{targetChars}} が目標文字数へ置換されます</div>
    </div>

    <div class="zlc-btn-row">
      <button class="zlc-btn primary" data-el="btnSaveSettings">保存</button>
      <button class="zlc-btn" data-el="btnTestLlm">接続テスト</button>
      <button class="zlc-btn" data-el="btnOpenOptions">エンドポイント権限の設定</button>
    </div>
    <div class="zlc-status-line" data-el="settingsStatus"></div>
  </section>
</div>
`;

export class ZlcPanel {
  private hostEl!: HTMLDivElement;
  private shadow!: ShadowRoot;
  private rootEl!: HTMLDivElement;
  private els = new Map<string, HTMLElement>();

  private settings!: Settings;
  private hasApiKey = false;

  private width = 420;
  private collapsed = false;
  private overlayMode = false;

  private summarySource: SummarySource = { kind: "live" };
  private lastSummary: LastSummaryContext | null = null;
  private summarizing = false;
  private pendingRemoteRun: (() => void) | null = null;

  private resizeListener = () => this.applyLayout();

  constructor(private readonly hostApi: PanelHost) {}

  /* ------------------------------------------------------------------ */
  /* mount / layout                                                      */

  mount(initial: SettingsResult): void {
    if (document.getElementById(HOST_ID)) return; // 二重inject防止 (§13)

    this.settings = initial.settings;
    this.hasApiKey = initial.hasApiKey;
    this.width = clampWidth(initial.settings.panelWidth);

    this.hostEl = document.createElement("div");
    this.hostEl.id = HOST_ID;
    const s = this.hostEl.style;
    s.setProperty("position", "fixed", "important");
    s.setProperty("top", "0", "important");
    s.setProperty("right", "0", "important");
    s.setProperty("height", "100vh", "important");
    s.setProperty("z-index", "2147483646", "important");
    s.setProperty("margin", "0", "important");
    s.setProperty("padding", "0", "important");
    s.setProperty("border", "none", "important");
    s.setProperty("background", "transparent", "important");

    this.shadow = this.hostEl.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = panelCss;
    this.shadow.appendChild(style);

    const wrapper = document.createElement("div");
    wrapper.innerHTML = TEMPLATE; // 静的テンプレートのみ。動的値は含まない (§35)
    this.rootEl = wrapper.querySelector(".zlc-root") as HTMLDivElement;
    this.shadow.appendChild(this.rootEl);

    this.rootEl.querySelectorAll<HTMLElement>("[data-el]").forEach((el) => {
      this.els.set(el.dataset.el as string, el);
    });

    this.bindEvents();
    this.populateSettingsForm();
    this.refreshSummaryProviderInfo();
    this.updateAutoSaveBadge();
    (this.el("summaryTarget") as HTMLInputElement).value = String(
      this.settings.defaultTargetChars,
    );
    this.rebuildSummarySourceSelect();

    (document.body ?? document.documentElement).appendChild(this.hostEl);
    window.addEventListener("resize", this.resizeListener);
    this.applyLayout();
  }

  unmount(): void {
    window.removeEventListener("resize", this.resizeListener);
    document.getElementById(DOCK_STYLE_ID)?.remove();
    this.hostEl?.remove();
  }

  /** Room ページ以外ではペインを隠す。 */
  setVisible(visible: boolean): void {
    if (!this.hostEl) return;
    this.hostEl.style.setProperty("display", visible ? "block" : "none", "important");
    if (visible) {
      this.applyLayout();
    } else {
      document.getElementById(DOCK_STYLE_ID)?.remove();
    }
  }

  private el(name: string): HTMLElement {
    const el = this.els.get(name);
    if (!el) throw new Error(`panel element not found: ${name}`);
    return el;
  }
  private input(name: string): HTMLInputElement {
    return this.el(name) as HTMLInputElement;
  }
  private textarea(name: string): HTMLTextAreaElement {
    return this.el(name) as HTMLTextAreaElement;
  }
  private select(name: string): HTMLSelectElement {
    return this.el(name) as HTMLSelectElement;
  }

  private applyLayout(): void {
    this.overlayMode = window.innerWidth < OVERLAY_VIEWPORT_THRESHOLD;
    const effectiveWidth = this.collapsed ? 34 : this.width;
    this.hostEl.style.setProperty("width", `${effectiveWidth}px`, "important");
    this.rootEl.classList.toggle("collapsed", this.collapsed);

    // Dock (§18): ユーザーが明示的に有効化した場合のみ、#contents を CSS で縮める。
    // 既定は Overlay（Zeta のページ CSS へ一切介入しない）。
    // 実レイアウト差異による崩れを避けるため、#contents が実際にチャットログの
    // 祖先であるときだけ適用し、margin-right のみを使う。
    let dockStyle = document.getElementById(DOCK_STYLE_ID) as HTMLStyleElement | null;
    const contents = document.querySelector("#contents");
    const shouldDock =
      this.settings.layoutMode === "dock" &&
      !this.overlayMode &&
      contents !== null &&
      contents.querySelector('[role="log"]') !== null;
    if (shouldDock) {
      if (!dockStyle) {
        dockStyle = document.createElement("style");
        dockStyle.id = DOCK_STYLE_ID;
        document.head.appendChild(dockStyle);
      }
      const css = `#contents { margin-right: ${effectiveWidth}px !important; }`;
      if (dockStyle.textContent !== css) dockStyle.textContent = css;
    } else if (dockStyle) {
      dockStyle.remove();
    }
  }

  private bindResize(): void {
    const handle = this.el("resizeHandle");
    let dragging = false;
    handle.addEventListener("pointerdown", (ev) => {
      dragging = true;
      handle.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    });
    handle.addEventListener("pointermove", (ev) => {
      if (!dragging) return;
      this.width = clampWidth(window.innerWidth - ev.clientX);
      this.applyLayout();
    });
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      this.settings.panelWidth = this.width;
      (this.el("setPanelWidth") as HTMLInputElement).value = String(this.width);
      void sendToBackground<SettingsResult>({
        type: "SAVE_SETTINGS",
        settings: this.settings,
      });
    };
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }

  /* ------------------------------------------------------------------ */
  /* events                                                              */

  private bindEvents(): void {
    this.bindResize();

    this.el("btnCollapse").addEventListener("click", () => {
      this.collapsed = true;
      this.applyLayout();
    });
    this.el("btnExpand").addEventListener("click", () => {
      this.collapsed = false;
      this.applyLayout();
    });

    this.rootEl.querySelectorAll<HTMLButtonElement>(".zlc-tabs button").forEach(
      (btn) => {
        btn.addEventListener("click", () => this.switchTab(btn.dataset.tab ?? "live"));
      },
    );

    // LIVE
    this.el("btnFullSync").addEventListener("click", () => {
      this.hostApi.requestFullSync();
    });
    this.el("btnSaveNow").addEventListener("click", () => {
      this.hostApi.requestSaveNow();
    });
    this.el("btnCopyLive").addEventListener("click", async () => {
      const ok = await copyToClipboard(this.textarea("liveText").value);
      this.setStatus("liveStatus", ok ? "コピーしました" : "コピーに失敗しました", ok ? "ok" : "error");
    });

    // ARCHIVES
    this.el("btnReloadArchives").addEventListener("click", () => {
      void this.refreshArchives();
    });
    this.el("btnArchiveBack").addEventListener("click", () => {
      this.el("archiveDetailView").hidden = true;
      this.el("archiveListView").hidden = false;
      void this.refreshArchives();
    });
    this.el("btnArchiveCopy").addEventListener("click", async () => {
      const ok = await copyToClipboard(this.textarea("archiveText").value);
      this.setStatus("archiveDetailStatus", ok ? "コピーしました" : "コピーに失敗しました", ok ? "ok" : "error");
    });
    this.el("btnArchiveDelete").addEventListener("click", () => {
      void this.deleteCurrentArchive();
    });
    this.el("btnArchiveSummarize").addEventListener("click", () => {
      if (!this.currentArchive) return;
      this.summarySource = {
        kind: "archive",
        snapshotId: this.currentArchive.snapshot.id,
        label: this.currentArchive.snapshot.displayName,
        text: this.currentArchive.text,
      };
      this.rebuildSummarySourceSelect();
      this.switchTab("summary");
    });

    // SUMMARY
    this.select("summarySource").addEventListener("change", () => {
      const v = this.select("summarySource").value;
      if (v === "live") this.summarySource = { kind: "live" };
      // archive の場合は既存の summarySource(archive) を保持
    });
    this.el("btnSummarize").addEventListener("click", () => {
      void this.runSummarize(false);
    });
    this.el("btnRemoteProceed").addEventListener("click", () => {
      this.el("remoteConfirm").hidden = true;
      const run = this.pendingRemoteRun;
      this.pendingRemoteRun = null;
      run?.();
    });
    this.el("btnRemoteCancel").addEventListener("click", () => {
      this.el("remoteConfirm").hidden = true;
      this.pendingRemoteRun = null;
      this.setStatus("summaryStatus", "送信をキャンセルしました", "");
    });
    this.el("btnOpenOptionsFromSummary").addEventListener("click", () => {
      void sendToBackground({ type: "OPEN_OPTIONS" });
    });
    this.el("btnCopySummary").addEventListener("click", async () => {
      const ok = await copyToClipboard(this.textarea("summaryText").value);
      this.setStatus("summaryStatus", ok ? "コピーしました" : "コピーに失敗しました", ok ? "ok" : "error");
    });
    this.el("btnSaveSummary").addEventListener("click", () => {
      void this.saveCurrentSummary();
    });
    this.el("btnRegenerate").addEventListener("click", () => {
      void this.runSummarize(false);
    });

    // SETTINGS
    this.select("setProvider").addEventListener("change", () => {
      this.toggleProviderFields(this.select("setProvider").value as Settings["provider"]);
    });
    this.el("btnSaveSettings").addEventListener("click", () => {
      void this.saveSettingsFromForm();
    });
    this.el("btnClearApiKey").addEventListener("click", () => {
      void this.clearApiKey();
    });
    this.el("btnTestLlm").addEventListener("click", () => {
      void this.testConnection();
    });
    this.el("btnOpenOptions").addEventListener("click", () => {
      void sendToBackground({ type: "OPEN_OPTIONS" });
    });
  }

  private switchTab(tab: string): void {
    this.rootEl.querySelectorAll<HTMLButtonElement>(".zlc-tabs button").forEach(
      (btn) => btn.classList.toggle("active", btn.dataset.tab === tab),
    );
    this.rootEl
      .querySelectorAll<HTMLElement>("[data-panel]")
      .forEach((panel) => (panel.hidden = panel.dataset.panel !== tab));

    if (tab === "archives") void this.refreshArchives();
    if (tab === "summary") this.refreshSummaryProviderInfo();
  }

  /* ------------------------------------------------------------------ */
  /* LIVE                                                                */

  setPlotName(name: string | null): void {
    this.el("plotName").textContent = name ?? "—";
  }

  updateLive(messageCount: number, charCount: number, text: string): void {
    this.el("liveMessages").textContent = `${messageCount} messages`;
    this.el("liveChars").textContent = `${charCount.toLocaleString("en-US")} characters`;
    const ta = this.textarea("liveText");
    if (this.shadow.activeElement !== ta) {
      const nearBottom = ta.scrollTop + ta.clientHeight >= ta.scrollHeight - 40;
      ta.value = text;
      if (nearBottom) ta.scrollTop = ta.scrollHeight;
    }
  }

  setLastSaved(result: SaveSnapshotResult | null): void {
    this.el("lastSaved").textContent = result
      ? `Last saved ${formatTimeLocal(result.savedAt)}`
      : "未保存";
  }

  updateAutoSaveBadge(): void {
    const badge = this.el("autoSaveBadge");
    const on = this.settings.autoSaveEnabled;
    badge.textContent = on ? "● Auto Save" : "○ Auto Save OFF";
    badge.classList.toggle("on", on);
    badge.classList.toggle("off", !on);
  }

  setSyncProgress(message: string | null): void {
    const box = this.el("syncProgress");
    const btn = this.el("btnFullSync") as HTMLButtonElement;
    if (message === null) {
      box.hidden = true;
      btn.disabled = false;
    } else {
      box.hidden = false;
      box.textContent = message;
      btn.disabled = true;
    }
  }

  setLiveStatus(message: string, kind: "" | "ok" | "error" | "busy" = ""): void {
    this.setStatus("liveStatus", message, kind);
  }

  /** §34 のエラー表示。 */
  showGlobalStatus(message: string | null, kind: "error" | "info" = "info"): void {
    const box = this.el("globalStatus");
    if (message === null) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.textContent = message;
    box.classList.remove("error", "info");
    box.classList.add(kind);
  }

  /* ------------------------------------------------------------------ */
  /* ARCHIVES                                                            */

  private currentArchive: ArchiveDetail | null = null;

  private async refreshArchives(): Promise<void> {
    this.setStatus("archivesStatus", "読み込み中…", "busy");
    const res = await sendToBackground<SnapshotRecord[]>({ type: "GET_ARCHIVES" });
    if (!res.ok) {
      this.setStatus("archivesStatus", `読み込み失敗: ${res.error}`, "error");
      return;
    }
    this.setStatus("archivesStatus", "", "");
    this.renderArchiveList(res.data);
  }

  private renderArchiveList(items: SnapshotRecord[]): void {
    const list = this.el("archivesList");
    list.textContent = "";
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "zlc-empty";
      empty.textContent = "保存されたログはまだありません";
      list.appendChild(empty);
      return;
    }
    for (const snap of items) {
      const item = document.createElement("div");
      item.className = "zlc-archive-item";

      const name = document.createElement("div");
      name.className = "name";
      name.textContent = snap.displayName;

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `${formatTimeLocal(snap.updatedAt)} ・ ${snap.messageCount} messages ・ ${snap.characterCount.toLocaleString("en-US")} chars`;

      item.appendChild(name);
      item.appendChild(meta);
      item.addEventListener("click", () => void this.openArchive(snap.id));
      list.appendChild(item);
    }
  }

  private async openArchive(snapshotId: string): Promise<void> {
    this.setStatus("archivesStatus", "読み込み中…", "busy");
    const res = await sendToBackground<ArchiveDetail>({
      type: "GET_ARCHIVE",
      snapshotId,
    });
    if (!res.ok) {
      this.setStatus("archivesStatus", `読み込み失敗: ${res.error}`, "error");
      return;
    }
    this.setStatus("archivesStatus", "", "");
    this.currentArchive = res.data;

    this.el("archiveListView").hidden = true;
    this.el("archiveDetailView").hidden = false;
    this.el("archiveTitle").textContent = res.data.snapshot.displayName;
    this.el("archiveMeta").textContent =
      `${res.data.snapshot.messageCount} messages ・ ${res.data.snapshot.characterCount.toLocaleString("en-US")} chars ・ 更新 ${formatTimeLocal(res.data.snapshot.updatedAt)}`;
    this.textarea("archiveText").value = res.data.text;
    this.textarea("archiveText").scrollTop = 0;
    this.setStatus("archiveDetailStatus", "", "");
    this.renderArchiveSummaries(res.data);
  }

  private renderArchiveSummaries(detail: ArchiveDetail): void {
    const box = this.el("archiveSummaries");
    const title = this.el("archiveSummariesTitle");
    box.textContent = "";
    title.hidden = detail.summaries.length === 0;
    for (const summary of detail.summaries) {
      const item = document.createElement("div");
      item.className = "zlc-summary-item";
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `${formatTimeLocal(summary.createdAt)} ・ ${summary.actualChars} chars ・ ${summary.provider}`;
      const body = document.createElement("div");
      body.className = "body";
      body.textContent = summary.text;
      item.appendChild(meta);
      item.appendChild(body);
      box.appendChild(item);
    }
  }

  private async deleteCurrentArchive(): Promise<void> {
    if (!this.currentArchive) return;
    const name = this.currentArchive.snapshot.displayName;
    if (!window.confirm(`アーカイブ「${name}」を削除しますか？`)) return;
    const res = await sendToBackground({
      type: "DELETE_ARCHIVE",
      snapshotId: this.currentArchive.snapshot.id,
    });
    if (!res.ok) {
      this.setStatus("archiveDetailStatus", `削除失敗: ${res.error}`, "error");
      return;
    }
    this.currentArchive = null;
    this.el("archiveDetailView").hidden = true;
    this.el("archiveListView").hidden = false;
    void this.refreshArchives();
  }

  /* ------------------------------------------------------------------ */
  /* SUMMARY                                                             */

  private rebuildSummarySourceSelect(): void {
    const select = this.select("summarySource");
    select.textContent = "";
    const live = document.createElement("option");
    live.value = "live";
    live.textContent = "Current conversation（現在の会話）";
    select.appendChild(live);
    if (this.summarySource.kind === "archive") {
      const arc = document.createElement("option");
      arc.value = "archive";
      arc.textContent = `Archive: ${this.summarySource.label}`;
      select.appendChild(arc);
      select.value = "archive";
    } else {
      select.value = "live";
    }
  }

  private refreshSummaryProviderInfo(): void {
    const providerName =
      this.settings.provider === "openai-compatible"
        ? "OpenAI Compatible"
        : "Generic JSON HTTP";
    const endpoint =
      this.settings.provider === "openai-compatible"
        ? this.settings.openaiCompatible.endpoint
        : this.settings.genericJson.url;
    const model =
      this.settings.provider === "openai-compatible"
        ? this.settings.openaiCompatible.model || "(model 未設定)"
        : "-";

    this.el("summaryProviderName").textContent = `${providerName} / ${model}`;
    const badge = this.el("summaryEndpointBadge");
    if (!endpoint) {
      badge.textContent = "未設定";
      badge.classList.remove("local", "remote");
    } else if (isLocalEndpoint(endpoint)) {
      badge.textContent = "LOCAL";
      badge.classList.add("local");
      badge.classList.remove("remote");
    } else {
      badge.textContent = "REMOTE";
      badge.classList.add("remote");
      badge.classList.remove("local");
    }
    this.el("summaryProviderDetail").textContent = endpoint || "SETTINGS タブで Endpoint を設定してください";
  }

  setSummaryProgress(message: string): void {
    if (this.summarizing) {
      this.setStatus("summaryStatus", message, "busy");
    }
  }

  private resolveSummaryInput(): {
    text: string;
    sourceLabel: string;
    roomId: string | null;
    snapshotId: string | null;
  } | null {
    const selected = this.select("summarySource").value;
    if (selected === "archive" && this.summarySource.kind === "archive") {
      return {
        text: this.summarySource.text,
        sourceLabel: this.summarySource.label,
        roomId: this.summarySource.snapshotId.split(":")[0] ?? null,
        snapshotId: this.summarySource.snapshotId,
      };
    }
    const ctx = this.hostApi.getRoomContext();
    const text = this.hostApi.getLiveText();
    if (!text) {
      this.setStatus("summaryStatus", "要約対象の会話がありません", "error");
      return null;
    }
    return {
      text,
      sourceLabel: `${ctx.plotName ?? "現在の会話"} (LIVE)`,
      roomId: ctx.roomId,
      snapshotId: null,
    };
  }

  private async runSummarize(confirmRemote: boolean): Promise<void> {
    if (this.summarizing) return;
    const input = this.resolveSummaryInput();
    if (!input) return;

    const targetChars = Math.max(
      100,
      Number.parseInt(this.input("summaryTarget").value, 10) ||
        this.settings.defaultTargetChars,
    );

    this.summarizing = true;
    (this.el("btnSummarize") as HTMLButtonElement).disabled = true;
    this.el("permissionActions").hidden = true;
    this.setStatus("summaryStatus", "要約を開始します…", "busy");

    const res = await sendToBackground<SummarizeResult>({
      type: "SUMMARIZE",
      text: input.text,
      targetChars,
      sourceLabel: input.sourceLabel,
      roomId: input.roomId,
      snapshotId: input.snapshotId,
      confirmRemote,
    });

    this.summarizing = false;
    (this.el("btnSummarize") as HTMLButtonElement).disabled = false;

    if (!res.ok) {
      if (res.code === "NEEDS_REMOTE_CONFIRM") {
        // §31: 外部送信前の確認。ユーザーが「続行」を押したときのみ再実行する。
        this.el("remoteConfirmDest").textContent = res.origin ?? "(不明)";
        this.el("remoteConfirm").hidden = false;
        this.pendingRemoteRun = () => void this.runSummarize(true);
        this.setStatus("summaryStatus", "", "");
        return;
      }
      if (res.code === "NEEDS_HOST_PERMISSION") {
        this.el("permissionActions").hidden = false;
        this.setStatus("summaryStatus", res.error, "error");
        return;
      }
      this.setStatus("summaryStatus", `要約に失敗しました: ${res.error}`, "error");
      return;
    }

    this.lastSummary = {
      result: res.data,
      sourceLabel: input.sourceLabel,
      roomId: input.roomId,
      snapshotId: input.snapshotId,
      targetChars,
    };
    const parts: string[] = [];
    if (res.data.chunkCount > 1) parts.push(`${res.data.chunkCount} チャンクに分割`);
    if (res.data.recompressCount > 0)
      parts.push(`再圧縮 ${res.data.recompressCount} 回`);
    this.setStatus(
      "summaryStatus",
      parts.length > 0 ? `完了（${parts.join(" / ")}）` : "完了",
      "ok",
    );

    this.el("summaryResultBlock").hidden = false;
    this.el("summaryResultChars").textContent =
      `${res.data.chars.toLocaleString("en-US")} characters（目標 ${targetChars.toLocaleString("en-US")}）`;
    this.textarea("summaryText").value = res.data.text;
  }

  private async saveCurrentSummary(): Promise<void> {
    if (!this.lastSummary) return;
    const { result, sourceLabel, roomId, snapshotId, targetChars } = this.lastSummary;
    const input: SummaryInput = {
      roomId,
      snapshotId,
      sourceLabel,
      provider: result.provider,
      model: result.model,
      targetChars,
      actualChars: result.chars,
      text: result.text,
    };
    const res = await sendToBackground({ type: "SAVE_SUMMARY", summary: input });
    this.setStatus(
      "summaryStatus",
      res.ok ? "要約を保存しました" : `保存失敗: ${res.error}`,
      res.ok ? "ok" : "error",
    );
  }

  /* ------------------------------------------------------------------ */
  /* SETTINGS                                                            */

  private populateSettingsForm(): void {
    const st = this.settings;
    this.input("setAutoSave").checked = st.autoSaveEnabled;
    this.input("setDebounce").value = String(st.autoSaveDebounceMs);
    this.input("setTargetChars").value = String(st.defaultTargetChars);
    this.input("setPanelWidth").value = String(st.panelWidth);
    this.select("setLayoutMode").value = st.layoutMode;
    this.input("setMaxInput").value = String(st.maxInputCharsPerRequest);
    this.input("setSpeakerLabels").checked = st.format.speakerLabels;
    this.input("setNarrationLabels").checked = st.format.narrationLabels;

    this.select("setProvider").value = st.provider;
    this.toggleProviderFields(st.provider);

    this.input("setOaiEndpoint").value = st.openaiCompatible.endpoint;
    this.input("setOaiModel").value = st.openaiCompatible.model;
    this.input("setOaiTemperature").value = String(st.openaiCompatible.temperature);

    this.input("setGjUrl").value = st.genericJson.url;
    this.select("setGjMethod").value = st.genericJson.method;
    this.textarea("setGjHeaders").value = JSON.stringify(
      st.genericJson.headers,
      null,
      2,
    );
    this.textarea("setGjTemplate").value = st.genericJson.requestTemplate;
    this.input("setGjPath").value = st.genericJson.responsePath;

    this.input("setApiKey").value = "";
    this.el("apiKeyHint").textContent = this.hasApiKey
      ? "APIキーは保存済みです。変更する場合のみ入力してください。"
      : "未設定です。";
    this.input("setRememberKey").checked = st.rememberApiKey;

    this.textarea("setInstruction").value = st.summaryInstruction;
  }

  private toggleProviderFields(provider: Settings["provider"]): void {
    this.el("openaiFields").hidden = provider !== "openai-compatible";
    this.el("genericFields").hidden = provider !== "generic-json";
  }

  private collectSettingsForm(): Settings | string {
    const readInt = (name: string, min: number, fallback: number): number => {
      const v = Number.parseInt(this.input(name).value, 10);
      return Number.isFinite(v) ? Math.max(min, v) : fallback;
    };

    let headers: Record<string, string>;
    const headersRaw = this.textarea("setGjHeaders").value.trim();
    if (headersRaw === "") {
      headers = {};
    } else {
      try {
        const parsed = JSON.parse(headersRaw) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return "Headers は JSON オブジェクトで指定してください";
        }
        headers = {};
        for (const [k, v] of Object.entries(parsed)) headers[k] = String(v);
      } catch {
        return "Headers の JSON が不正です";
      }
    }

    const provider = this.select("setProvider").value as Settings["provider"];
    const template = this.textarea("setGjTemplate").value;
    if (provider === "generic-json") {
      try {
        JSON.parse(template);
      } catch {
        return "JSON Request Template が JSON として不正です";
      }
    }

    const temperature = Number.parseFloat(this.input("setOaiTemperature").value);

    return {
      autoSaveEnabled: this.input("setAutoSave").checked,
      autoSaveDebounceMs: readInt("setDebounce", 500, 2000),
      defaultTargetChars: readInt("setTargetChars", 100, 2000),
      panelWidth: clampWidth(readInt("setPanelWidth", PANEL_MIN_WIDTH, 420)),
      layoutMode:
        this.select("setLayoutMode").value === "dock" ? "dock" : "overlay",
      format: {
        speakerLabels: this.input("setSpeakerLabels").checked,
        narrationLabels: this.input("setNarrationLabels").checked,
      },
      provider,
      openaiCompatible: {
        endpoint: this.input("setOaiEndpoint").value.trim(),
        model: this.input("setOaiModel").value.trim(),
        temperature: Number.isFinite(temperature) ? temperature : 0.2,
      },
      genericJson: {
        url: this.input("setGjUrl").value.trim(),
        method: this.select("setGjMethod").value as Settings["genericJson"]["method"],
        headers,
        requestTemplate: template,
        responsePath: this.input("setGjPath").value.trim(),
      },
      summaryInstruction: this.textarea("setInstruction").value,
      maxInputCharsPerRequest: readInt("setMaxInput", 2000, 12000),
      rememberApiKey: this.input("setRememberKey").checked,
      acknowledgedRemoteOrigins: this.settings.acknowledgedRemoteOrigins,
    };
  }

  private async saveSettingsFromForm(): Promise<void> {
    const collected = this.collectSettingsForm();
    if (typeof collected === "string") {
      this.setStatus("settingsStatus", collected, "error");
      return;
    }
    const apiKeyValue = this.input("setApiKey").value;
    const res = await sendToBackground<SettingsResult>({
      type: "SAVE_SETTINGS",
      settings: collected,
      // 空欄は「変更なし」。削除は btnClearApiKey で明示的に行う。
      apiKey: apiKeyValue !== "" ? apiKeyValue : undefined,
    });
    if (!res.ok) {
      this.setStatus("settingsStatus", `保存失敗: ${res.error}`, "error");
      return;
    }
    this.settings = res.data.settings;
    this.hasApiKey = res.data.hasApiKey;
    this.width = clampWidth(this.settings.panelWidth);
    this.populateSettingsForm();
    this.refreshSummaryProviderInfo();
    this.updateAutoSaveBadge();
    this.applyLayout();
    this.hostApi.onSettingsApplied(this.settings);
    this.setStatus("settingsStatus", "保存しました", "ok");
  }

  private async clearApiKey(): Promise<void> {
    const res = await sendToBackground<SettingsResult>({
      type: "SAVE_SETTINGS",
      settings: this.settings,
      apiKey: "",
    });
    if (res.ok) {
      this.hasApiKey = res.data.hasApiKey;
      this.input("setApiKey").value = "";
      this.el("apiKeyHint").textContent = "未設定です。";
      this.setStatus("settingsStatus", "APIキーを削除しました", "ok");
    } else {
      this.setStatus("settingsStatus", `削除失敗: ${res.error}`, "error");
    }
  }

  private async testConnection(): Promise<void> {
    this.setStatus("settingsStatus", "接続テスト中…（未保存の変更は反映されません）", "busy");
    const res = await sendToBackground<TestConnectionResult>({
      type: "TEST_LLM_CONNECTION",
    });
    if (!res.ok) {
      if (res.code === "NEEDS_HOST_PERMISSION") {
        this.setStatus(
          "settingsStatus",
          `${res.error}「エンドポイント権限の設定」から許可してください。`,
          "error",
        );
      } else {
        this.setStatus("settingsStatus", res.error, "error");
      }
      return;
    }
    this.setStatus(
      "settingsStatus",
      `[${res.data.endpointKind}] ${res.data.detail}`,
      res.data.ok ? "ok" : "error",
    );
  }

  /* ------------------------------------------------------------------ */

  private setStatus(
    name: string,
    message: string,
    kind: "" | "ok" | "error" | "busy",
  ): void {
    const el = this.el(name);
    el.textContent = message;
    el.classList.remove("ok", "error", "busy");
    if (kind) el.classList.add(kind);
  }
}

function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return 420;
  return Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, Math.round(width)));
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
