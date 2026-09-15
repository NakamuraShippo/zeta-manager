/**
 * Service Worker (§25)。
 * - IndexedDB 操作 / Archive 管理 / Settings 管理 / LLM HTTP 通信
 * - LLM の接続先は保存済み設定からのみ解決する。content script から渡された
 *   URL を fetch することはない (§23)。
 * - API キーは chrome.storage.session（明示オプトイン時のみ local）に保存し、
 *   content script へは返さない (§16)。
 */

import { openDatabase } from "../storage/database";
import { ArchiveRepository } from "../storage/archive-repository";
import type {
  ArchiveDetail,
  BackgroundErrorCode,
  BackgroundRequest,
  BackgroundResponse,
  SaveSnapshotResult,
  SettingsResult,
  SummarizeResult,
  TestConnectionResult,
} from "../shared/messages";
import {
  defaultSettings,
  type Settings,
  type SummaryRecord,
} from "../shared/types";
import {
  formatDateLocal,
  isLocalEndpoint,
  originOf,
  originPatternOf,
  randomId,
} from "../shared/utils";
import type { LlmProvider } from "../llm/provider";
import { LlmError } from "../llm/provider";
import { OpenAiCompatibleProvider } from "../llm/openai-compatible";
import { GenericJsonProvider } from "../llm/generic-json";
import { runSummarization } from "../llm/summarizer";

const repo = new ArchiveRepository(openDatabase());

const SETTINGS_KEY = "settings";
const API_KEY_KEY = "apiKey";

// ---------------------------------------------------------------------------
// 初期化

async function restrictSessionStorage(): Promise<void> {
  try {
    await chrome.storage.session.setAccessLevel({
      accessLevel: "TRUSTED_CONTEXTS" as chrome.storage.AccessLevel,
    });
  } catch {
    // 既定でも content script からは読めないため致命的ではない
  }
}

void restrictSessionStorage();

chrome.runtime.onInstalled.addListener(() => {
  void restrictSessionStorage();
});

chrome.action?.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

// ---------------------------------------------------------------------------
// Settings / API key

function mergeSettings(stored: Partial<Settings> | undefined): Settings {
  const d = defaultSettings();
  if (!stored) return d;
  return {
    ...d,
    ...stored,
    format: { ...d.format, ...(stored.format ?? {}) },
    openaiCompatible: { ...d.openaiCompatible, ...(stored.openaiCompatible ?? {}) },
    genericJson: { ...d.genericJson, ...(stored.genericJson ?? {}) },
    acknowledgedRemoteOrigins: Array.isArray(stored.acknowledgedRemoteOrigins)
      ? stored.acknowledgedRemoteOrigins
      : d.acknowledgedRemoteOrigins,
  };
}

async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return mergeSettings(stored[SETTINGS_KEY] as Partial<Settings> | undefined);
}

async function persistSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

async function getApiKey(): Promise<string | null> {
  const session = await chrome.storage.session.get(API_KEY_KEY);
  if (typeof session[API_KEY_KEY] === "string" && session[API_KEY_KEY]) {
    return session[API_KEY_KEY] as string;
  }
  const local = await chrome.storage.local.get(API_KEY_KEY);
  if (typeof local[API_KEY_KEY] === "string" && local[API_KEY_KEY]) {
    return local[API_KEY_KEY] as string;
  }
  return null;
}

async function setApiKey(value: string, remember: boolean): Promise<void> {
  if (value === "") {
    await chrome.storage.session.remove(API_KEY_KEY);
    await chrome.storage.local.remove(API_KEY_KEY);
    return;
  }
  if (remember) {
    await chrome.storage.local.set({ [API_KEY_KEY]: value });
    await chrome.storage.session.remove(API_KEY_KEY);
  } else {
    await chrome.storage.session.set({ [API_KEY_KEY]: value });
    await chrome.storage.local.remove(API_KEY_KEY);
  }
}

// ---------------------------------------------------------------------------
// LLM

function resolveEndpoint(settings: Settings): string {
  return settings.provider === "openai-compatible"
    ? settings.openaiCompatible.endpoint
    : settings.genericJson.url;
}

function buildProvider(settings: Settings, apiKey: string | null): LlmProvider {
  if (settings.provider === "openai-compatible") {
    return new OpenAiCompatibleProvider(settings.openaiCompatible, apiKey);
  }
  return new GenericJsonProvider(settings.genericJson, apiKey);
}

class HandlerError extends Error {
  constructor(
    readonly code: BackgroundErrorCode,
    message: string,
    readonly origin?: string,
  ) {
    super(message);
  }
}

/**
 * endpoint の妥当性・host permission・リモート送信同意 (§23 / §24 / §31) を検査する。
 * @returns "LOCAL" | "REMOTE"
 */
async function ensureEndpointAllowed(
  settings: Settings,
  options: { confirmRemote: boolean; requireAcknowledge: boolean },
): Promise<"LOCAL" | "REMOTE"> {
  const endpoint = resolveEndpoint(settings);
  if (!endpoint) {
    throw new HandlerError(
      "PROVIDER_NOT_CONFIGURED",
      "LLM Provider の Endpoint が設定されていません。SETTINGS タブで設定してください。",
    );
  }
  const origin = originOf(endpoint);
  const pattern = originPatternOf(endpoint);
  if (!origin || !pattern) {
    throw new HandlerError(
      "PROVIDER_NOT_CONFIGURED",
      `Endpoint URL が不正です: ${endpoint}`,
    );
  }

  if (isLocalEndpoint(endpoint)) {
    return "LOCAL";
  }

  // リモート送信の事前同意 (§31)
  if (options.requireAcknowledge) {
    const acknowledged = settings.acknowledgedRemoteOrigins.includes(origin);
    if (!acknowledged && !options.confirmRemote) {
      throw new HandlerError(
        "NEEDS_REMOTE_CONFIRM",
        `この会話ログは設定された外部LLMサービスへ送信されます。送信先: ${origin}`,
        origin,
      );
    }
    if (!acknowledged && options.confirmRemote) {
      settings.acknowledgedRemoteOrigins = [
        ...settings.acknowledgedRemoteOrigins,
        origin,
      ];
      await persistSettings(settings);
    }
  }

  // optional host permission (§24)
  const granted = await chrome.permissions.contains({ origins: [pattern] });
  if (!granted) {
    throw new HandlerError(
      "NEEDS_HOST_PERMISSION",
      `${origin} へのアクセス権限がありません。拡張機能のオプションページから許可してください。`,
      origin,
    );
  }
  return "REMOTE";
}

/** MV3 service worker が長時間の要約中に停止しないよう keepalive する。 */
function startKeepAlive(): () => void {
  const timer = setInterval(() => {
    void chrome.runtime.getPlatformInfo();
  }, 20_000);
  return () => clearInterval(timer);
}

function pushProgress(tabId: number | undefined, message: string): void {
  if (tabId === undefined) return;
  chrome.tabs
    .sendMessage(tabId, { type: "SUMMARY_PROGRESS", message })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// ハンドラ

async function handleRequest(
  request: BackgroundRequest,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  switch (request.type) {
    case "UPSERT_MESSAGES": {
      const now = Date.now();
      await repo.upsertRoom(request.room, now);
      await repo.upsertMessages(request.room.roomId, request.records);
      return { stored: request.records.length };
    }

    case "SAVE_SNAPSHOT": {
      const now = Date.now();
      const settings = await loadSettings();
      const snapshot = await repo.saveSnapshot(
        request.room,
        formatDateLocal(now),
        settings.format,
        now,
      );
      if (!snapshot) {
        throw new HandlerError("NOT_FOUND", "保存対象のメッセージがありません");
      }
      const result: SaveSnapshotResult = { snapshot, savedAt: now };
      return result;
    }

    case "GET_ROOM_MESSAGES": {
      return await repo.getActiveMessages(request.roomId);
    }

    case "GET_ARCHIVES": {
      return await repo.listSnapshots();
    }

    case "GET_ARCHIVE": {
      const snapshot = await repo.getSnapshot(request.snapshotId);
      if (!snapshot) {
        throw new HandlerError("NOT_FOUND", "アーカイブが見つかりません");
      }
      const settings = await loadSettings();
      const text = await repo.buildSnapshotText(snapshot, settings.format);
      const summaries = await repo.listSummariesForSnapshot(snapshot.id);
      const detail: ArchiveDetail = { snapshot, text, summaries };
      return detail;
    }

    case "DELETE_ARCHIVE": {
      await repo.deleteSnapshot(request.snapshotId);
      return { deleted: true };
    }

    case "SUMMARIZE": {
      const settings = await loadSettings();
      const endpointKind = await ensureEndpointAllowed(settings, {
        confirmRemote: request.confirmRemote === true,
        requireAcknowledge: true,
      });
      const apiKey = await getApiKey();
      const provider = buildProvider(settings, apiKey);
      const tabId = sender.tab?.id;

      const stopKeepAlive = startKeepAlive();
      try {
        const job = await runSummarization(provider, request.text, {
          targetChars: request.targetChars,
          instructionTemplate: settings.summaryInstruction,
          model: provider.model,
          temperature:
            settings.provider === "openai-compatible"
              ? settings.openaiCompatible.temperature
              : 0.2,
          maxInputCharsPerRequest: settings.maxInputCharsPerRequest,
          onProgress: (message) => pushProgress(tabId, message),
        });
        const result: SummarizeResult = {
          text: job.text,
          chars: job.chars,
          chunkCount: job.chunkCount,
          recompressCount: job.recompressCount,
          endpointKind,
          provider: settings.provider,
          model: provider.model,
        };
        return result;
      } catch (e) {
        if (e instanceof LlmError) {
          const detail = e.detail ? ` (${e.detail})` : "";
          throw new HandlerError("LLM_ERROR", `${e.message}${detail}`);
        }
        throw e;
      } finally {
        stopKeepAlive();
      }
    }

    case "SAVE_SUMMARY": {
      const record: SummaryRecord = {
        id: randomId(),
        roomId: request.summary.roomId ?? "",
        snapshotId: request.summary.snapshotId,
        sourceLabel: request.summary.sourceLabel,
        provider: request.summary.provider,
        model: request.summary.model,
        targetChars: request.summary.targetChars,
        actualChars: request.summary.actualChars,
        text: request.summary.text,
        createdAt: Date.now(),
      };
      await repo.saveSummary(record);
      return record;
    }

    case "GET_SUMMARIES": {
      return await repo.listSummariesForRoom(request.roomId);
    }

    case "GET_SETTINGS": {
      const settings = await loadSettings();
      const hasApiKey = (await getApiKey()) !== null;
      const result: SettingsResult = { settings, hasApiKey };
      return result;
    }

    case "SAVE_SETTINGS": {
      const merged = mergeSettings(request.settings);
      await persistSettings(merged);
      if (request.apiKey !== undefined) {
        await setApiKey(request.apiKey, merged.rememberApiKey);
      } else {
        // remember 設定の切り替え時は既存キーを保存先間で移動する
        const existing = await getApiKey();
        if (existing !== null) await setApiKey(existing, merged.rememberApiKey);
      }
      const hasApiKey = (await getApiKey()) !== null;
      const result: SettingsResult = { settings: merged, hasApiKey };
      return result;
    }

    case "TEST_LLM_CONNECTION": {
      const settings = await loadSettings();
      // 接続テストは会話ログを送信しないため §31 の同意は不要。permission のみ検査。
      const endpointKind = await ensureEndpointAllowed(settings, {
        confirmRemote: false,
        requireAcknowledge: false,
      });
      const apiKey = await getApiKey();
      try {
        let detail: string;
        if (settings.provider === "openai-compatible") {
          const provider = new OpenAiCompatibleProvider(
            settings.openaiCompatible,
            apiKey,
          );
          detail = await provider.testConnection();
        } else {
          const provider = new GenericJsonProvider(settings.genericJson, apiKey);
          const out = await provider.summarize(
            "接続テストです。「OK」とだけ返してください。",
            {
              targetChars: 10,
              instruction: "「OK」とだけ返してください。",
              model: "",
              temperature: 0,
            },
          );
          detail = `接続OK。応答: ${out.slice(0, 50)}`;
        }
        const result: TestConnectionResult = { ok: true, endpointKind, detail };
        return result;
      } catch (e) {
        const message =
          e instanceof LlmError
            ? `${e.message}${e.detail ? ` (${e.detail})` : ""}`
            : e instanceof Error
              ? e.message
              : String(e);
        const result: TestConnectionResult = {
          ok: false,
          endpointKind,
          detail: message,
        };
        return result;
      }
    }

    case "OPEN_OPTIONS": {
      await chrome.runtime.openOptionsPage();
      return { opened: true };
    }

    default: {
      const exhaustive: never = request;
      throw new HandlerError("INTERNAL", `未知のメッセージ: ${JSON.stringify(exhaustive)}`);
    }
  }
}

chrome.runtime.onMessage.addListener(
  (
    request: BackgroundRequest,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: BackgroundResponse) => void,
  ) => {
    if (!request || typeof request !== "object" || !("type" in request)) {
      return false;
    }
    handleRequest(request, sender)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e: unknown) => {
        if (e instanceof HandlerError) {
          sendResponse({
            ok: false,
            error: e.message,
            code: e.code,
            origin: e.origin,
          });
        } else {
          sendResponse({
            ok: false,
            error: e instanceof Error ? e.message : String(e),
            code: "INTERNAL",
          });
        }
      });
    return true; // 非同期応答
  },
);
