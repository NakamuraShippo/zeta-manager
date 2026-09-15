/**
 * content script ↔ service worker 間のメッセージ定義 (§25)。
 *
 * セキュリティ上の規約 (§23):
 * - content script から任意 URL を渡して fetch させるメッセージは存在しない。
 *   LLM の接続先は service worker が保存済み設定から読む。
 * - API キーは SAVE_SETTINGS の書き込み専用フィールドでのみ受け取り、
 *   GET_SETTINGS では hasApiKey (boolean) だけを返す。
 */

import type {
  MessageRecord,
  RoomInfo,
  Settings,
  SnapshotRecord,
  SummaryRecord,
} from "./types";

export type BackgroundRequest =
  | { type: "UPSERT_MESSAGES"; room: RoomInfo; records: MessageRecord[] }
  | { type: "SAVE_SNAPSHOT"; room: RoomInfo }
  /** Room 入室時の順序シード用: 保存済み active メッセージを index 昇順で返す */
  | { type: "GET_ROOM_MESSAGES"; roomId: string }
  | { type: "GET_ARCHIVES" }
  | { type: "GET_ARCHIVE"; snapshotId: string }
  | { type: "DELETE_ARCHIVE"; snapshotId: string }
  | {
      type: "SUMMARIZE";
      /** 要約対象の統合テキスト（会話本文のみ。HTML やメタ情報を含めない） */
      text: string;
      targetChars: number;
      sourceLabel: string;
      roomId: string | null;
      snapshotId: string | null;
      /** §31 のリモート送信警告にユーザーが同意済みであることを示す */
      confirmRemote?: boolean;
    }
  | { type: "SAVE_SUMMARY"; summary: SummaryInput }
  | { type: "GET_SUMMARIES"; roomId: string }
  | { type: "GET_SETTINGS" }
  | {
      type: "SAVE_SETTINGS";
      settings: Settings;
      /**
       * APIキー（書き込み専用）。
       * undefined = 変更なし / "" = 削除 / それ以外 = 新しい値を保存。
       */
      apiKey?: string;
    }
  | { type: "TEST_LLM_CONNECTION" }
  | { type: "OPEN_OPTIONS" };

export interface SummaryInput {
  roomId: string | null;
  snapshotId: string | null;
  sourceLabel: string;
  provider: string;
  model: string;
  targetChars: number;
  actualChars: number;
  text: string;
}

export interface SummarizeResult {
  text: string;
  chars: number;
  /** 分割要約したチャンク数（1 なら単発） */
  chunkCount: number;
  /** 文字数収束のための再圧縮回数 */
  recompressCount: number;
  endpointKind: "LOCAL" | "REMOTE";
  provider: string;
  model: string;
}

export interface SettingsResult {
  settings: Settings;
  hasApiKey: boolean;
}

export interface ArchiveDetail {
  snapshot: SnapshotRecord;
  text: string;
  summaries: SummaryRecord[];
}

export interface SaveSnapshotResult {
  snapshot: SnapshotRecord;
  savedAt: number;
}

export interface TestConnectionResult {
  ok: boolean;
  endpointKind: "LOCAL" | "REMOTE";
  detail: string;
}

/** エラー応答の code。panel 側の分岐に使用する。 */
export type BackgroundErrorCode =
  | "NEEDS_REMOTE_CONFIRM"
  | "NEEDS_HOST_PERMISSION"
  | "PROVIDER_NOT_CONFIGURED"
  | "LLM_ERROR"
  | "NOT_FOUND"
  | "INTERNAL";

export type BackgroundResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: BackgroundErrorCode; origin?: string };

/** service worker → content script へのプッシュ通知。 */
export type BackgroundPush = {
  type: "SUMMARY_PROGRESS";
  message: string;
};

/** 型付き sendMessage ラッパ（content script / options page 用）。 */
export function sendToBackground<T>(
  request: BackgroundRequest,
): Promise<BackgroundResponse<T>> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(request, (response?: BackgroundResponse<T>) => {
        const err = chrome.runtime.lastError;
        if (err || !response) {
          resolve({
            ok: false,
            error: err?.message ?? "background service worker から応答がありません",
            code: "INTERNAL",
          });
          return;
        }
        resolve(response);
      });
    } catch (e) {
      resolve({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        code: "INTERNAL",
      });
    }
  });
}
