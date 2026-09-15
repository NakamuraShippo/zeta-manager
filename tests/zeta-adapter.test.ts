// @vitest-environment jsdom
/**
 * zeta2.html fixture を用いた Extractor の回帰テスト (§33)。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  collectDiagnostics,
  findLogContainer,
  findMessageNodes,
  getPlotName,
  getRoomId,
  parseAllMessages,
  parseMessage,
  sortMessages,
} from "../src/content/zeta-adapter";
import {
  ConversationStore,
  partitionVariantSlots,
} from "../src/content/conversation-capture";
import type { MessageRecord } from "../src/shared/types";

const ROOM_ID = "dd03b207-dc2e-46a0-93a7-4b2fd4903958";
// jsdom 環境では import.meta.url が file スキームにならないため cwd 基準で解決する
const fixtureHtml = readFileSync(
  resolve(process.cwd(), "tests/fixtures/zeta2.html"),
  "utf8",
);

let doc: Document;

beforeEach(() => {
  doc = new DOMParser().parseFromString(fixtureHtml, "text/html");
});

describe("getRoomId (§3.2)", () => {
  it("locale 付き rooms URL から Room ID を取得する", () => {
    expect(getRoomId(`/ja/rooms/${ROOM_ID}`)).toBe(ROOM_ID);
  });

  it("locale なしや末尾パス付きでも取得できる", () => {
    expect(getRoomId(`/rooms/${ROOM_ID}`)).toBe(ROOM_ID);
    expect(getRoomId(`/en/rooms/${ROOM_ID}/settings`)).toBe(ROOM_ID);
  });

  it("rooms ページ以外では null", () => {
    expect(getRoomId("/ja/explore")).toBeNull();
    expect(getRoomId("/ja/rooms/")).toBeNull();
    expect(getRoomId("/")).toBeNull();
  });
});

describe("fixture 解析 (§33)", () => {
  it('plotName = "共依存"', () => {
    expect(getPlotName(doc)).toBe("共依存");
  });

  it("会話コンテナが見つかる", () => {
    const container = findLogContainer(doc);
    expect(container).not.toBeNull();
    expect(container?.getAttribute("aria-label")).toBe("Chat messages");
  });

  it("message 数 = 17 で first-guide を含めない", () => {
    const nodes = findMessageNodes(doc);
    expect(nodes).toHaveLength(17);
    for (const node of nodes) {
      expect(node.getAttribute("data-key")).not.toBe("first-guide");
      expect(node.getAttribute("data-key")).toMatch(/^message-/);
    }
    // fixture 内には first-guide 自体は存在している
    expect(doc.querySelector('[data-key="first-guide"]')).not.toBeNull();
  });

  it("data-index 1〜17 を取得し、並び順が 1→17 になる (§7)", () => {
    const records = sortMessages(parseAllMessages(ROOM_ID, doc));
    expect(records).toHaveLength(17);
    expect(records.map((r) => r.index)).toEqual(
      Array.from({ length: 17 }, (_, i) => i + 1),
    );
    // DOM 出現順は逆順（17→1）であることを前提に、ソートで正順になることを確認
    const domOrder = findMessageNodes(doc).map((n) =>
      Number.parseInt(n.getAttribute("data-index") ?? "0", 10),
    );
    expect(domOrder[0]).toBe(17);
    expect(domOrder[domOrder.length - 1]).toBe(1);
  });

  it("index=1 が USER（話者コウ）", () => {
    const records = sortMessages(parseAllMessages(ROOM_ID, doc));
    const first = records[0];
    expect(first.index).toBe(1);
    expect(first.role).toBe("user");
    expect(first.speaker).toBe("コウ");
    expect(first.parts).toHaveLength(1);
    expect(first.parts[0].type).toBe("user");
    expect(first.parts[0].text).toBe(
      "5日目\nコウは友人宅を最後に軽く掃除して、鍵を返した。",
    );
  });

  it("index=2 が AI で、ナレーション+キャラクター本文の 2 パートを持つ (§5.2)", () => {
    const records = sortMessages(parseAllMessages(ROOM_ID, doc));
    const second = records[1];
    expect(second.index).toBe(2);
    expect(second.role).toBe("ai");
    expect(second.speaker).toBe("翠");
    expect(second.parts).toHaveLength(2);

    expect(second.parts[0].type).toBe("narration");
    expect(second.parts[0].text).toBe(
      "五日目。コウは友人宅を出た。\nまた同じことをした、という顔で。",
    );

    expect(second.parts[1].type).toBe("character");
    expect(second.parts[1].speaker).toBe("翠");
    expect(second.parts[1].text).toBe(
      "翠のスマホが鳴った。\n仕事の依頼主。三度目の着信。",
    );
  });

  it("絵文字・改行・段落を保持する (§8)", () => {
    const records = sortMessages(parseAllMessages(ROOM_ID, doc));
    const third = records[2];
    expect(third.parts[0].text).toContain("🎵");
    expect(third.parts[0].text).toBe(
      "ちゃららん…🎵\n聞き慣れた着信音が部屋に響いた。",
    );

    const fifth = records[4];
    expect(fifth.parts[0].text).toBe(
      "引っ越しの荷物は少ない。\n\n段ボール三つで、コウの生活は全部だった。",
    );

    const eighth = records[7];
    expect(eighth.parts[0].text).toBe(
      "「港区のマンション。今夜からでも入れる部屋がある」\n翠は淡々と続けた。",
    );
  });

  it("ナレーションのみのメッセージも AI として取得する", () => {
    const records = sortMessages(parseAllMessages(ROOM_ID, doc));
    const sixth = records[5];
    expect(sixth.index).toBe(6);
    expect(sixth.role).toBe("ai");
    expect(sixth.parts).toHaveLength(1);
    expect(sixth.parts[0].type).toBe("narration");
  });

  it("UI ノイズ（ボタン・ウォーターマーク・alt・ガイド・Suggested replies）を含めない (§8)", () => {
    const records = parseAllMessages(ROOM_ID, doc);
    const allText = records
      .flatMap((r) => r.parts.map((p) => p.text))
      .join("\n");
    expect(allText).not.toContain("コピー");
    expect(allText).not.toContain("再生成");
    expect(allText).not.toContain("zeta");
    expect(allText).not.toContain("アバター");
    expect(allText).not.toContain("メッセージメニュー");
    expect(allText).not.toContain("物語が始まります"); // first-guide
    expect(allText).not.toContain("「どんな部屋？」と聞く"); // suggested reply
    expect(allText).not.toContain("メッセージを入力"); // 入力欄
    // 話者名ラベル (caption1) は本文へ混入しない
    const userTexts = records
      .filter((r) => r.role === "user")
      .flatMap((r) => r.parts.map((p) => p.text));
    for (const text of userTexts) {
      expect(text.startsWith("コウ")).toBe(false);
    }
  });

  it("parseMessage は message- 以外の data-key を null にする", () => {
    const guide = doc.querySelector<HTMLElement>('[data-key="first-guide"]');
    expect(guide).not.toBeNull();
    expect(parseMessage(guide as HTMLElement, ROOM_ID)).toBeNull();
  });

  it("診断情報は selector 成否とメッセージ数のみを持つ (§34)", () => {
    const diag = collectDiagnostics(doc, `/ja/rooms/${ROOM_ID}`, "0.1.0");
    expect(diag).toEqual({
      pathname: `/ja/rooms/${ROOM_ID}`,
      roomId: ROOM_ID,
      plotNameFound: true,
      logContainerFound: true,
      messageNodeCount: 17,
      extensionVersion: "0.1.0",
    });
  });
});

describe("ConversationStore: 時系列接合", () => {
  /** fixture の全メッセージを時系列順（= mergeWindow へ渡す視覚順の模擬）で得る */
  function chronological(): MessageRecord[] {
    return sortMessages(parseAllMessages(ROOM_ID, doc));
  }

  /** 1-based の範囲でウィンドウを切り出す（仮想スクロールのマウント範囲の模擬） */
  function windowOf(all: MessageRecord[], from: number, to: number): MessageRecord[] {
    return all.slice(from - 1, to);
  }

  it("同じウィンドウを 2 回 merge しても重複しない (§33)", () => {
    const store = new ConversationStore();
    const all = chronological();
    const first = store.mergeWindow(all);
    expect(first.added).toBe(17);
    expect(store.size).toBe(17);

    const second = store.mergeWindow(all);
    expect(second.added).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(17);
    expect(store.size).toBe(17);
    expect(store.getActiveSorted()).toHaveLength(17);
    expect(store.getActiveSorted().map((r) => r.index)).toEqual(
      Array.from({ length: 17 }, (_, i) => i + 1),
    );
  });

  it("重なり合うウィンドウをアンカーで接合し、時系列を保つ", () => {
    const store = new ConversationStore();
    const all = chronological();
    // 最下部のウィンドウから取得開始（通常の入室状態）
    store.mergeWindow(windowOf(all, 12, 17));
    // 上へスクロール: 重なりのあるウィンドウ
    store.mergeWindow(windowOf(all, 8, 13));
    store.mergeWindow(windowOf(all, 4, 9));
    store.mergeWindow(windowOf(all, 1, 5));

    const active = store.getActiveSorted();
    expect(active.map((r) => r.messageKey)).toEqual(all.map((r) => r.messageKey));
    expect(active.map((r) => r.index)).toEqual(
      Array.from({ length: 17 }, (_, i) => i + 1),
    );
  });

  it("重ならないウィンドウは messageKey の数値 ID で位置を推定する", () => {
    const store = new ConversationStore();
    const all = chronological();
    store.mergeWindow(windowOf(all, 10, 17)); // 新しい側
    store.mergeWindow(windowOf(all, 1, 5)); // 古い側（アンカーなし）

    const keys = store.getActiveSorted().map((r) => r.messageKey);
    expect(keys).toEqual([
      ...windowOf(all, 1, 5).map((r) => r.messageKey),
      ...windowOf(all, 10, 17).map((r) => r.messageKey),
    ]);
  });

  it("再生成スワイプ（カルーセル変種が DOM に残る）は表示中の 1 件だけを正とする", () => {
    const store = new ConversationStore();
    const all = chronological();
    store.mergeWindow(all);
    store.drainDirty();

    const oldLast = all[16];
    const regenerated: MessageRecord = {
      ...oldLast,
      messageKey: "message-MESSAGE-9999999999999-regn",
      parts: [{ type: "user", speaker: "コウ", text: "「……別の答えを試そう」" }],
      contentHash: "regen-hash",
    };

    // 旧変種は DOM に残ったまま横へ押し出され（displaced）、新変種が表示中。
    // atBottom に依存せず置き換えられることを確認する。
    const stats = store.mergeWindow([...windowOf(all, 15, 16), regenerated], {
      atBottom: false,
      displaced: [oldLast],
    });
    expect(stats.deactivated).toBe(1);

    const active = store.getActiveSorted();
    expect(active).toHaveLength(17);
    expect(active[16].messageKey).toBe("message-MESSAGE-9999999999999-regn");
    expect(active.map((r) => r.messageKey)).not.toContain(oldLast.messageKey);

    // スワイプで旧変種へ戻した場合は逆向きに入れ替わる
    store.mergeWindow([...windowOf(all, 15, 16), oldLast], {
      atBottom: false,
      displaced: [regenerated],
    });
    const restored = store.getActiveSorted();
    expect(restored).toHaveLength(17);
    expect(restored[16].messageKey).toBe(oldLast.messageKey);
    expect(restored.map((r) => r.messageKey)).not.toContain(
      regenerated.messageKey,
    );
    expect(restored.map((r) => r.index)).toEqual(
      Array.from({ length: 17 }, (_, i) => i + 1),
    );
  });

  it("再生成（最下部で旧 key が消え新 key が現れる）を差し替える (§12)", () => {
    const store = new ConversationStore();
    const all = chronological();
    store.mergeWindow(all);
    store.drainDirty();

    const oldLast = all[16];
    const regenerated: MessageRecord = {
      ...oldLast,
      messageKey: "message-MESSAGE-9999999999999-regn",
      parts: [{ type: "user", speaker: "コウ", text: "「……少し考えさせて」" }],
      contentHash: "regen-hash",
    };
    // 最下部のマウント範囲: 15,16 + 再生成された新メッセージ
    const stats = store.mergeWindow(
      [...windowOf(all, 15, 16), regenerated],
      { atBottom: true },
    );

    expect(stats.deactivated).toBe(1); // 旧 17 番目
    expect(store.size).toBe(18); // 旧メッセージも byKey には残す (§12)
    const active = store.getActiveSorted();
    expect(active).toHaveLength(17);
    expect(active[16].messageKey).toBe("message-MESSAGE-9999999999999-regn");
    expect(active[16].index).toBe(17);
    expect(active.map((r) => r.messageKey)).not.toContain(oldLast.messageKey);
  });

  it("生成途中の内容更新（同 key・別 hash）を updated として取り込む (§11)", () => {
    const store = new ConversationStore();
    const all = chronological();
    store.mergeWindow(all);
    store.drainDirty();

    const target = all[3];
    const updated: MessageRecord = {
      ...target,
      parts: [
        {
          type: "character",
          speaker: "翠",
          text: "「……もしもし。今、大丈夫。続きがある」",
        },
      ],
      contentHash: "updated-hash",
    };
    const stats = store.mergeWindow(windowOf(all, 1, 17).map((r) =>
      r.messageKey === target.messageKey ? updated : r,
    ));
    expect(stats.updated).toBe(1);
    expect(stats.added).toBe(0);

    const dirty = store.drainDirty();
    expect(dirty).toHaveLength(1);
    expect(dirty[0].messageKey).toBe(target.messageKey);
    expect(dirty[0].parts[0].text).toContain("続きがある");
  });

  it("seed した保存済み順序へ新しいウィンドウを接合できる", () => {
    const store = new ConversationStore();
    const all = chronological();
    store.seed(windowOf(all, 1, 15)); // 前セッションの保存分
    expect(store.hasDirty()).toBe(false);

    // 入室時に見えている最下部ウィンドウ（既知 13-15 + 新規 16,17）
    store.mergeWindow(windowOf(all, 13, 17), { atBottom: true });
    const active = store.getActiveSorted();
    expect(active.map((r) => r.messageKey)).toEqual(all.map((r) => r.messageKey));
    expect(active.map((r) => r.index)).toEqual(
      Array.from({ length: 17 }, (_, i) => i + 1),
    );
  });

  it("beginRebuild/finishRebuild: 上→下パスで再構築し、未走査分は先頭側へ戻す", () => {
    const store = new ConversationStore();
    const all = chronological();
    store.mergeWindow(all);

    store.beginRebuild();
    // パスが途中で中断され、3〜7 しか走査できなかったと仮定
    store.mergeWindow(windowOf(all, 3, 5));
    store.mergeWindow(windowOf(all, 4, 7));
    store.finishRebuild();

    const keys = store.getActiveSorted().map((r) => r.messageKey);
    expect(keys).toEqual(all.map((r) => r.messageKey)); // 全 17 件が時系列で残る
    expect(store.getActiveSorted().map((r) => r.index)).toEqual(
      Array.from({ length: 17 }, (_, i) => i + 1),
    );
  });

  it("drainDirty は差分のみを返し、送信失敗時は markDirty で戻せる", () => {
    const store = new ConversationStore();
    store.mergeWindow(sortMessages(parseAllMessages(ROOM_ID, doc)));
    const dirty = store.drainDirty();
    expect(dirty).toHaveLength(17);
    expect(store.hasDirty()).toBe(false);

    store.markDirty(dirty.slice(0, 3));
    expect(store.hasDirty()).toBe(true);
    expect(store.drainDirty()).toHaveLength(3);
  });
});

describe("partitionVariantSlots: 再生成スワイプの変種判定", () => {
  it("縦に重なる変種グループから中央に最も近い 1 件を表示中として選ぶ", () => {
    const items = [
      { top: 0, height: 100, centerX: 400 }, // 通常メッセージ
      { top: 120, height: 80, centerX: 400 }, // 表示中の変種
      { top: 120, height: 90, centerX: 1100 }, // 右へ押し出された変種
      { top: 125, height: 60, centerX: -300 }, // 左側の変種
    ];
    const { visible, displaced } = partitionVariantSlots(items, 400);
    expect(visible).toEqual([0, 1]);
    expect(displaced).toEqual([2, 3]);
  });

  it("縦に重ならない通常のメッセージ列はすべて表示扱いになる", () => {
    const items = [
      { top: 0, height: 100, centerX: 400 },
      { top: 110, height: 100, centerX: 400 },
      { top: 220, height: 100, centerX: 400 },
    ];
    const { visible, displaced } = partitionVariantSlots(items, 400);
    expect(visible).toEqual([0, 1, 2]);
    expect(displaced).toEqual([]);
  });

  it("高さの異なる変種同士（本文長の違い）も同一スロットとして扱う", () => {
    const items = [
      { top: 200, height: 240, centerX: 400 }, // 長い変種（表示中）
      { top: 205, height: 90, centerX: 1200 }, // 短い変種（非表示）
    ];
    const { visible, displaced } = partitionVariantSlots(items, 400);
    expect(visible).toEqual([0]);
    expect(displaced).toEqual([1]);
  });
});
