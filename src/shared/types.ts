/**
 * Zeta Log Companion 共通型定義。
 * 仕様書 §6 / §15 / §16 / §20-22 に対応する。
 */

export type MessagePartType = "user" | "narration" | "character";

export interface MessagePart {
  type: MessagePartType;
  speaker?: string;
  text: string;
}

export interface MessageRecord {
  roomId: string;

  messageKey: string;
  index: number;

  role: "user" | "ai";
  speaker: string | null;

  parts: MessagePart[];

  capturedAt: number;
  updatedAt: number;

  contentHash: string;
  active: boolean;
}

export interface RoomRecord {
  roomId: string;
  plotName: string;
  url: string;

  firstSeenAt: number;
  lastSeenAt: number;
}

export interface SnapshotRecord {
  id: string; // `${roomId}:${YYYY-MM-DD}`

  roomId: string;
  date: string; // YYYY-MM-DD (ローカルタイム)

  displayName: string; // `${plotName}_${date}`

  messageKeys: string[];

  messageCount: number;
  characterCount: number;

  createdAt: number;
  updatedAt: number;
}

export interface SummaryRecord {
  id: string;
  roomId: string;
  snapshotId: string | null;
  sourceLabel: string;

  provider: string;
  model: string;

  targetChars: number;
  actualChars: number;

  text: string;
  createdAt: number;
}

/** Room の基本情報（content script → service worker 間で受け渡す）。 */
export interface RoomInfo {
  roomId: string;
  plotName: string;
  url: string;
}

export type ProviderKind = "openai-compatible" | "generic-json";

export interface OpenAiCompatibleSettings {
  /** 例: http://127.0.0.1:1234/v1/chat/completions */
  endpoint: string;
  model: string;
  temperature: number;
}

export type GenericJsonMethod = "POST" | "PUT" | "GET";

export interface GenericJsonSettings {
  url: string;
  method: GenericJsonMethod;
  /** ヘッダ。値には {{apiKey}} placeholder を使用できる（service worker 側で置換）。 */
  headers: Record<string, string>;
  /** JSON リクエストテンプレート文字列。{{text}} {{targetChars}} {{instruction}} {{model}} {{apiKey}} を置換。 */
  requestTemplate: string;
  /** 応答 JSON から本文を取り出す dot notation パス。例: "result.text", "choices.0.message.content" */
  responsePath: string;
}

export interface FormatOptions {
  /** 話者ラベル [USER: xx] / [AI: xx] / [CHARACTER: xx] を付けるか */
  speakerLabels: boolean;
  /** [NARRATION] / [CHARACTER] ラベルを付けるか */
  narrationLabels: boolean;
}

/**
 * ペインの表示モード (§18)。
 * overlay: Zeta のページ CSS へ一切介入しない（既定・安全）
 * dock:    #contents をペイン幅ぶん CSS で縮める（実験的。Zeta のレイアウトに依存）
 */
export type LayoutMode = "overlay" | "dock";

export interface Settings {
  autoSaveEnabled: boolean;
  autoSaveDebounceMs: number;

  defaultTargetChars: number;
  panelWidth: number;
  layoutMode: LayoutMode;

  format: FormatOptions;

  provider: ProviderKind;
  openaiCompatible: OpenAiCompatibleSettings;
  genericJson: GenericJsonSettings;

  /** 要約 system prompt テンプレート。{{targetChars}} を置換する。 */
  summaryInstruction: string;

  /** Map-Reduce 分割時の 1 リクエスト最大入力文字数 (§29) */
  maxInputCharsPerRequest: number;

  /** APIキーを chrome.storage.local に保存するか（既定は session のみ） */
  rememberApiKey: boolean;

  /** 外部送信を承認済みの origin 一覧 (§31) */
  acknowledgedRemoteOrigins: string[];
}

/** 仕様書 §28 のデフォルト要約プロンプト。 */
export const DEFAULT_SUMMARY_INSTRUCTION = `あなたは物語のコンテキストを圧縮する編集者です。

与えられた会話ログを、指定された文字数を目安に日本語で要約してください。

必ず保持してください：

・登場人物
・人物の性格
・人物同士の関係
・重要な出来事
・感情や関係性の変化
・現在の状況
・場所と時間
・未解決の問題
・今後の展開に必要な伏線
・人物が明確に発言した重要な事実

新しい設定や出来事を追加してはいけません。

文章として自然にまとめてください。

目標文字数：
{{targetChars}}文字`;

export function defaultSettings(): Settings {
  return {
    autoSaveEnabled: true,
    autoSaveDebounceMs: 2000,

    defaultTargetChars: 2000,
    panelWidth: 420,
    layoutMode: "overlay",

    format: {
      speakerLabels: true,
      narrationLabels: true,
    },

    provider: "openai-compatible",
    openaiCompatible: {
      endpoint: "http://127.0.0.1:1234/v1/chat/completions",
      model: "",
      temperature: 0.2,
    },
    genericJson: {
      url: "",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      requestTemplate: `{
  "model": "{{model}}",
  "prompt": "{{instruction}}\\n\\n{{text}}",
  "target_length": "{{targetChars}}"
}`,
      responsePath: "result.text",
    },

    summaryInstruction: DEFAULT_SUMMARY_INSTRUCTION,

    maxInputCharsPerRequest: 12000,

    rememberApiKey: false,
    acknowledgedRemoteOrigins: [],
  };
}

export const PANEL_MIN_WIDTH = 320;
export const PANEL_MAX_WIDTH = 700;
export const PANEL_DEFAULT_WIDTH = 420;

/** これ未満の viewport 幅では Dock ではなく Overlay 表示にする (§18) */
export const OVERLAY_VIEWPORT_THRESHOLD = 960;
