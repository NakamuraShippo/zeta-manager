/**
 * オプションページ (§24)。
 * リモート LLM endpoint の optional host permission をユーザー操作で付与・撤回する。
 * permissions.request はユーザージェスチャが必要なため、拡張ページで実行する。
 */

import { sendToBackground, type SettingsResult } from "../shared/messages";
import { isLocalEndpoint, originPatternOf } from "../shared/utils";

const MANIFEST_ORIGINS = new Set([
  "https://zeta-ai.io/*",
  "http://localhost/*",
  "http://127.0.0.1/*",
]);

const endpointEl = document.getElementById("endpoint") as HTMLElement;
const grantBtn = document.getElementById("btnGrant") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLElement;
const grantedEl = document.getElementById("granted") as HTMLElement;

let currentPattern: string | null = null;

function setStatus(message: string, kind: "ok" | "error" | ""): void {
  statusEl.textContent = message;
  statusEl.className = kind;
}

async function refreshGrantedList(): Promise<void> {
  const all = await chrome.permissions.getAll();
  const optional = (all.origins ?? []).filter((o) => !MANIFEST_ORIGINS.has(o));
  grantedEl.textContent = "";
  if (optional.length === 0) {
    grantedEl.textContent = "追加で許可した origin はありません。";
    return;
  }
  for (const origin of optional) {
    const row = document.createElement("div");
    row.className = "row";
    const code = document.createElement("code");
    code.textContent = origin;
    const btn = document.createElement("button");
    btn.className = "secondary";
    btn.textContent = "取り消す";
    btn.addEventListener("click", async () => {
      await chrome.permissions.remove({ origins: [origin] });
      await refreshGrantedList();
    });
    row.appendChild(code);
    row.appendChild(btn);
    grantedEl.appendChild(row);
  }
}

async function init(): Promise<void> {
  const res = await sendToBackground<SettingsResult>({ type: "GET_SETTINGS" });
  if (!res.ok) {
    endpointEl.textContent = `設定を読み込めません: ${res.error}`;
    grantBtn.disabled = true;
    return;
  }
  const settings = res.data.settings;
  const endpoint =
    settings.provider === "openai-compatible"
      ? settings.openaiCompatible.endpoint
      : settings.genericJson.url;

  if (!endpoint) {
    endpointEl.textContent = "（Endpoint 未設定）";
    grantBtn.disabled = true;
    return;
  }

  endpointEl.textContent = endpoint;

  if (isLocalEndpoint(endpoint)) {
    grantBtn.disabled = true;
    setStatus("ローカル endpoint (LOCAL) は追加の許可なしで使用できます。", "ok");
    return;
  }

  currentPattern = originPatternOf(endpoint);
  if (!currentPattern) {
    grantBtn.disabled = true;
    setStatus("Endpoint URL が不正です。", "error");
    return;
  }

  const granted = await chrome.permissions.contains({ origins: [currentPattern] });
  if (granted) {
    setStatus("この origin は許可済みです。", "ok");
  }
}

grantBtn.addEventListener("click", async () => {
  if (!currentPattern) return;
  try {
    const granted = await chrome.permissions.request({
      origins: [currentPattern],
    });
    setStatus(
      granted ? "許可しました。" : "許可されませんでした。",
      granted ? "ok" : "error",
    );
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), "error");
  }
  await refreshGrantedList();
});

void init();
void refreshGrantedList();
