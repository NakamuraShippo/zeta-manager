/**
 * Zeta 固有の DOM 解析を隔離するアダプタ (§27)。
 * Zeta の HTML 構造が変更された場合は、まずこのファイルを修正する。
 *
 * 方針 (§3-§5):
 * - selector は data-testid / data-sentry-component / role を優先し、
 *   Tailwind 系 class への依存は最終 fallback に留める。
 * - 本文抽出は `.chat` 要素のみを対象とする whitelist 方式。
 *   ウォーターマーク・ボタン・Suggested replies 等は `.chat` の外にあるため
 *   自然に除外される。
 */

import type { MessagePart, MessageRecord } from "../shared/types";
import { fnv1a } from "../shared/utils";

export const ZETA_SELECTORS = {
  plotName: '[data-testid="chat-header-profile"]',
  logContainer: '[role="log"][aria-label="Chat messages"]',
  logContainerFallback: '[role="log"]',
  messageNodes: '[data-key^="message-"][data-index]',
  chat: ".chat",
  userContent: '[data-sentry-component="RightTextContent"]',
  aiContent: '[data-sentry-component="LeftTextContent"]',
  narration: '[data-sentry-component="NarratorBubble"]',
  speaker: "span.caption1",
} as const;

const ROOM_PATH_RE = /^(?:\/[A-Za-z0-9-]+)?\/rooms\/([0-9a-fA-F-]{8,64})(?:\/|$)/;

/** URL pathname から Room ID を取得する (§3.2)。 */
export function getRoomId(pathname?: string): string | null {
  const p = pathname ?? (typeof location !== "undefined" ? location.pathname : "");
  const m = ROOM_PATH_RE.exec(p);
  return m ? m[1] : null;
}

/** プロット名を取得する (§3.1)。 */
export function getPlotName(root: ParentNode = document): string | null {
  const el = root.querySelector(ZETA_SELECTORS.plotName);
  const text = el?.textContent?.trim();
  return text ? text : null;
}

/** 会話コンテナ (§4)。 */
export function findLogContainer(root: ParentNode = document): HTMLElement | null {
  const strict = root.querySelector<HTMLElement>(ZETA_SELECTORS.logContainer);
  if (strict) return strict;
  return root.querySelector<HTMLElement>(ZETA_SELECTORS.logContainerFallback);
}

/**
 * 現在 DOM にマウントされているメッセージ node を列挙する (§4)。
 * `data-key="first-guide"` のようなガイド要素は selector の段階で除外される。
 * 注意: 仮想スクロールのため、これは「全メッセージ」ではない (§9)。
 */
export function findMessageNodes(root: ParentNode = document): HTMLElement[] {
  const container = findLogContainer(root) ?? root;
  const nodes = Array.from(
    container.querySelectorAll<HTMLElement>(ZETA_SELECTORS.messageNodes),
  );
  return nodes.filter((n) =>
    (n.getAttribute("data-key") ?? "").startsWith("message-"),
  );
}

/** 1 メッセージ node を MessageRecord へ変換する (§5 / §6)。 */
export function parseMessage(
  node: HTMLElement,
  roomId: string,
  now: number = Date.now(),
): MessageRecord | null {
  const messageKey = node.getAttribute("data-key");
  const indexRaw = node.getAttribute("data-index");
  if (!messageKey || !messageKey.startsWith("message-")) return null;
  if (indexRaw === null) return null;
  const index = Number.parseInt(indexRaw, 10);
  if (!Number.isFinite(index)) return null;

  // `.chat` をすべて列挙し、所属コンポーネントから種別を判定する (§5.2)。
  const parts: MessagePart[] = [];
  const chats = Array.from(node.querySelectorAll<HTMLElement>(ZETA_SELECTORS.chat));
  for (const chat of chats) {
    const text = extractText(chat);
    if (!text) continue;

    if (chat.closest(ZETA_SELECTORS.narration)) {
      parts.push({ type: "narration", text });
      continue;
    }

    const userContainer = chat.closest<HTMLElement>(ZETA_SELECTORS.userContent);
    if (userContainer) {
      const speaker = findSpeaker(userContainer);
      parts.push(speaker ? { type: "user", speaker, text } : { type: "user", text });
      continue;
    }

    const aiContainer = chat.closest<HTMLElement>(ZETA_SELECTORS.aiContent);
    if (aiContainer) {
      const speaker = findSpeaker(aiContainer);
      parts.push(
        speaker
          ? { type: "character", speaker, text }
          : { type: "character", text },
      );
      continue;
    }

    // fallback: data-sentry-component が消えた場合の右寄せ構造ヒューリスティック (§5.1)。
    if (looksRightAligned(chat, node)) {
      parts.push({ type: "user", text });
    } else {
      parts.push({ type: "character", text });
    }
  }

  if (parts.length === 0) return null;

  const role: MessageRecord["role"] = parts.some((p) => p.type === "user")
    ? "user"
    : "ai";
  const speaker =
    parts.find((p) => p.speaker)?.speaker ?? findSpeaker(node) ?? null;

  return {
    roomId,
    messageKey,
    index,
    role,
    speaker,
    parts,
    capturedAt: now,
    updatedAt: now,
    contentHash: hashContent(role, parts),
    active: true,
  };
}

/** 現在 DOM の全メッセージを解析して返す（順序は保証しない）。 */
export function parseAllMessages(
  roomId: string,
  root: ParentNode = document,
  now: number = Date.now(),
): MessageRecord[] {
  const out: MessageRecord[] = [];
  for (const node of findMessageNodes(root)) {
    // 想定外の node 構造が 1 件あっても全体の取得を止めない
    try {
      const rec = parseMessage(node, roomId, now);
      if (rec) out.push(rec);
    } catch (e) {
      console.warn("[ZetaLogCompanion] parseMessage failed:", e);
    }
  }
  return out;
}

/** data-index 昇順にソートする (§7)。DOM 出現順や messageKey では並べない。 */
export function sortMessages(messages: MessageRecord[]): MessageRecord[] {
  return messages.slice().sort((a, b) => a.index - b.index);
}

export function hashContent(role: string, parts: MessagePart[]): string {
  const canonical = JSON.stringify([
    role,
    parts.map((p) => [p.type, p.speaker ?? "", p.text]),
  ]);
  return fnv1a(canonical);
}

function findSpeaker(scope: HTMLElement): string | null {
  const el = scope.querySelector<HTMLElement>(ZETA_SELECTORS.speaker);
  const text = el?.textContent?.trim();
  return text ? text : null;
}

function looksRightAligned(chat: HTMLElement, boundary: HTMLElement): boolean {
  let el: HTMLElement | null = chat;
  while (el && el !== boundary.parentElement) {
    const cls = el.getAttribute("class") ?? "";
    if (/(?:^|\s)(?:items-end|justify-end|self-end|text-right)(?:\s|$)/.test(cls)) {
      return true;
    }
    if (el === boundary) break;
    el = el.parentElement;
  }
  return false;
}

/**
 * 本文テキスト抽出。原則 innerText (§8)。
 * innerText が使えない環境（jsdom テスト等）では、<br> と block 要素を
 * 改行へ変換する fallback を使う。改行・絵文字・文中の空白は保持する。
 */
export function extractText(el: HTMLElement): string {
  const maybe = (el as { innerText?: unknown }).innerText;
  const raw =
    typeof maybe === "string" && maybe.length > 0 ? maybe : fallbackInnerText(el);
  return normalizeText(raw);
}

const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "BUTTON",
  "IMG",
  "SVG",
  "AUDIO",
  "VIDEO",
  "INPUT",
  "TEXTAREA",
  "SELECT",
]);

const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "SECTION",
  "ARTICLE",
  "LI",
  "UL",
  "OL",
  "BLOCKQUOTE",
  "PRE",
  "TR",
  "TABLE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "FOOTER",
  "FIGURE",
  "HR",
]);

function fallbackInnerText(root: Element): string {
  let out = "";

  // Chrome の innerText と同様、<p> の段落境界は空行 (\n\n) にする。
  const ensureBreaks = (count: number): void => {
    if (out.length === 0) return;
    let trailing = 0;
    while (trailing < out.length && out[out.length - 1 - trailing] === "\n") {
      trailing++;
    }
    for (let i = trailing; i < count; i++) out += "\n";
  };

  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      out += node.nodeValue ?? "";
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return;
    if (el.getAttribute("aria-hidden") === "true") return;
    if (tag === "BR") {
      out += "\n";
      return;
    }
    const isBlock = BLOCK_TAGS.has(tag);
    const breaks = tag === "P" ? 2 : isBlock ? 1 : 0;
    if (breaks > 0) ensureBreaks(breaks);
    for (const child of Array.from(node.childNodes)) walk(child);
    if (breaks > 0) ensureBreaks(breaks);
  };
  for (const child of Array.from(root.childNodes)) walk(child);
  return out;
}

function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** §34 の診断情報。HTML 全文・Cookie・Token は含めない。 */
export interface AdapterDiagnostics {
  pathname: string;
  roomId: string | null;
  plotNameFound: boolean;
  logContainerFound: boolean;
  messageNodeCount: number;
  extensionVersion: string;
}

export function collectDiagnostics(
  root: ParentNode = document,
  pathname?: string,
  extensionVersion = "",
): AdapterDiagnostics {
  const p = pathname ?? (typeof location !== "undefined" ? location.pathname : "");
  return {
    pathname: p,
    roomId: getRoomId(p),
    plotNameFound: getPlotName(root) !== null,
    logContainerFound: findLogContainer(root) !== null,
    messageNodeCount: findMessageNodes(root).length,
    extensionVersion,
  };
}
