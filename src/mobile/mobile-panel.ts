/**
 * モバイル（iOS Safari ユーザースクリプト）向けの浮動パネル。
 * - 左下の小さなフローティングボタン（メッセージ数バッジ付き）
 * - タップでシートを開き、全履歴同期・コピー・統合テキスト閲覧ができる
 * - 会話本文は必ず textContent / value で描画する（XSS 対策 §35）
 */

import panelCss from "./mobile-panel.css";
import { formatTimeLocal } from "../shared/utils";

export const MOBILE_HOST_ID = "zeta-log-companion-mobile-host";

export interface MobilePanelHost {
  getLiveText(): string;
  requestFullSync(): void;
}

/* 静的テンプレート。動的な値は一切埋め込まない。 */
const TEMPLATE = `
<div class="zlm-root">
  <button class="zlm-fab" data-el="fab" type="button">
    <span>LOG</span>
    <span class="count" data-el="fabCount">0</span>
  </button>

  <div class="zlm-sheet" data-el="sheet" hidden>
    <div class="zlm-sheet-body">
      <div class="zlm-header">
        <div class="zlm-title" data-el="plotName">—</div>
        <button class="zlm-close" data-el="btnClose" type="button">✕</button>
      </div>
      <div class="zlm-stats" data-el="stats">0 messages ・ 0 characters</div>
      <div class="zlm-save-row">
        <span class="zlm-badge" data-el="saveBadge">● Auto Save</span>
        <span data-el="lastSaved">未保存</span>
      </div>
      <div class="zlm-btn-row">
        <button class="zlm-btn primary" data-el="btnFullSync" type="button">全履歴を同期</button>
        <button class="zlm-btn" data-el="btnCopy" type="button">コピー</button>
      </div>
      <div class="zlm-progress" data-el="syncProgress" hidden></div>
      <div class="zlm-status" data-el="status"></div>
      <textarea class="zlm-text" data-el="liveText" readonly spellcheck="false"></textarea>
      <div class="zlm-note">Zeta Log Companion Mobile — 取得したログはこの端末内にのみ保存されます</div>
    </div>
  </div>
</div>
`;

export class MobilePanel {
  private hostEl!: HTMLDivElement;
  private els = new Map<string, HTMLElement>();

  constructor(private readonly hostApi: MobilePanelHost) {}

  mount(): void {
    if (document.getElementById(MOBILE_HOST_ID)) return;

    this.hostEl = document.createElement("div");
    this.hostEl.id = MOBILE_HOST_ID;

    const shadow = this.hostEl.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = panelCss;
    shadow.appendChild(style);

    const wrapper = document.createElement("div");
    wrapper.innerHTML = TEMPLATE; // 静的テンプレートのみ (§35)
    const root = wrapper.querySelector(".zlm-root") as HTMLDivElement;
    shadow.appendChild(root);

    root.querySelectorAll<HTMLElement>("[data-el]").forEach((el) => {
      this.els.set(el.dataset.el as string, el);
    });

    this.el("fab").addEventListener("click", () => {
      this.el("sheet").hidden = false;
    });
    this.el("btnClose").addEventListener("click", () => {
      this.el("sheet").hidden = true;
    });
    // 背景タップでも閉じる（シート本体のタップは無視）
    this.el("sheet").addEventListener("click", (ev) => {
      if (ev.target === this.el("sheet")) this.el("sheet").hidden = true;
    });
    this.el("btnFullSync").addEventListener("click", () => {
      this.hostApi.requestFullSync();
    });
    this.el("btnCopy").addEventListener("click", () => {
      void this.copyLiveText();
    });

    (document.body ?? document.documentElement).appendChild(this.hostEl);
  }

  private el(name: string): HTMLElement {
    const el = this.els.get(name);
    if (!el) throw new Error(`mobile panel element not found: ${name}`);
    return el;
  }

  setVisible(visible: boolean): void {
    if (!this.hostEl) return;
    this.hostEl.style.display = visible ? "" : "none";
    if (!visible) this.el("sheet").hidden = true;
  }

  setPlotName(name: string | null): void {
    this.el("plotName").textContent = name ?? "—";
  }

  updateLive(messageCount: number, charCount: number, text: string): void {
    this.el("fabCount").textContent = String(messageCount);
    this.el("stats").textContent =
      `${messageCount} messages ・ ${charCount.toLocaleString("en-US")} characters`;
    const ta = this.el("liveText") as HTMLTextAreaElement;
    const nearBottom = ta.scrollTop + ta.clientHeight >= ta.scrollHeight - 40;
    ta.value = text;
    if (nearBottom) ta.scrollTop = ta.scrollHeight;
  }

  setLastSaved(savedAt: number | null): void {
    this.el("lastSaved").textContent =
      savedAt === null ? "未保存" : `Last saved ${formatTimeLocal(savedAt)}`;
  }

  /** 保存が使えない環境（プライベートブラウズ等）でバッジを落とす。 */
  setSaveAvailable(available: boolean): void {
    const badge = this.el("saveBadge");
    badge.textContent = available ? "● Auto Save" : "○ 保存不可";
    badge.classList.toggle("off", !available);
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

  setStatus(message: string, kind: "" | "ok" | "error" | "busy" = ""): void {
    const el = this.el("status");
    el.textContent = message;
    el.classList.remove("ok", "error", "busy");
    if (kind) el.classList.add(kind);
  }

  private async copyLiveText(): Promise<boolean> {
    const text = this.hostApi.getLiveText();
    if (!text) {
      this.setStatus("コピーする会話がありません", "error");
      return false;
    }
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        ok = document.execCommand("copy");
        ta.remove();
      } catch {
        ok = false;
      }
    }
    this.setStatus(
      ok ? "コピーしました" : "コピーに失敗しました（本文を長押しで選択してください）",
      ok ? "ok" : "error",
    );
    return ok;
  }
}
