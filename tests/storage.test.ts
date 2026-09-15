/**
 * IndexedDB リポジトリ (§14 / §15) のテスト。fake-indexeddb を使用する。
 */

import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/database";
import {
  ArchiveRepository,
  snapshotIdOf,
} from "../src/storage/archive-repository";
import type { MessageRecord, RoomInfo, SummaryRecord } from "../src/shared/types";
import { DEFAULT_FORMAT_OPTIONS } from "../src/shared/text-format";

const ROOM_ID = "dd03b207-dc2e-46a0-93a7-4b2fd4903958";

const room: RoomInfo = {
  roomId: ROOM_ID,
  plotName: "共依存",
  url: `https://zeta-ai.io/ja/rooms/${ROOM_ID}`,
};

let dbCounter = 0;
function makeRepo(): ArchiveRepository {
  dbCounter++;
  return new ArchiveRepository(openDatabase(`zlc-test-${Date.now()}-${dbCounter}`));
}

function message(
  index: number,
  key: string,
  text: string,
  overrides: Partial<MessageRecord> = {},
): MessageRecord {
  const role = index % 2 === 1 ? "user" : "ai";
  return {
    roomId: ROOM_ID,
    messageKey: key,
    index,
    role,
    speaker: role === "user" ? "コウ" : "翠",
    parts: [
      role === "user"
        ? { type: "user", speaker: "コウ", text }
        : { type: "character", speaker: "翠", text },
    ],
    capturedAt: 1000 + index,
    updatedAt: 1000 + index,
    contentHash: `hash-${key}`,
    active: true,
    ...overrides,
  };
}

describe("ArchiveRepository messages", () => {
  it("同じ messageKey の upsert は重複せず内容を更新する", async () => {
    const repo = makeRepo();
    await repo.upsertMessages(ROOM_ID, [
      message(1, "message-a", "こんにちは"),
      message(2, "message-b", "ようこそ"),
    ]);
    await repo.upsertMessages(ROOM_ID, [
      message(1, "message-a", "こんにちは（編集後）", {
        contentHash: "hash-a2",
        updatedAt: 2000,
      }),
    ]);

    const all = await repo.getMessagesForRoom(ROOM_ID);
    expect(all).toHaveLength(2);
    const a = all.find((m) => m.messageKey === "message-a")!;
    expect(a.parts[0].text).toBe("こんにちは（編集後）");
    expect(a.capturedAt).toBe(1001); // 初回取得時刻は保持
  });

  it("active フラグと index は送信側の確定値をそのまま永続化する (§12)", async () => {
    const repo = makeRepo();
    await repo.upsertMessages(ROOM_ID, [
      message(1, "message-a", "ユーザー発言"),
      message(2, "message-b", "初回の返信"),
    ]);
    // 再生成: ConversationStore 側が旧メッセージを active=false、
    // 新メッセージを同じ index で active=true と確定して送ってくる
    await repo.upsertMessages(ROOM_ID, [
      message(2, "message-b", "初回の返信", { active: false }),
      message(2, "message-b2", "再生成された返信"),
    ]);

    const all = await repo.getMessagesForRoom(ROOM_ID);
    expect(all).toHaveLength(3);

    const active = await repo.getActiveMessages(ROOM_ID);
    expect(active).toHaveLength(2);
    expect(active.map((m) => m.messageKey)).toEqual(["message-a", "message-b2"]);

    const old = all.find((m) => m.messageKey === "message-b")!;
    expect(old.active).toBe(false);

    // 順序の振り直し（index 変更）も上書き保存される
    await repo.upsertMessages(ROOM_ID, [
      message(5, "message-a", "ユーザー発言"),
    ]);
    const moved = (await repo.getMessagesForRoom(ROOM_ID)).find(
      (m) => m.messageKey === "message-a",
    )!;
    expect(moved.index).toBe(5);
  });
});

describe("ArchiveRepository snapshots (§14)", () => {
  it("同一 Room・同一日付では同じ Snapshot を更新する", async () => {
    const repo = makeRepo();
    await repo.upsertMessages(ROOM_ID, [
      message(1, "message-a", "一通目"),
      message(2, "message-b", "二通目"),
    ]);

    const first = await repo.saveSnapshot(room, "2026-08-29", DEFAULT_FORMAT_OPTIONS, 10_000);
    expect(first).not.toBeNull();
    expect(first!.id).toBe(snapshotIdOf(ROOM_ID, "2026-08-29"));
    expect(first!.displayName).toBe("共依存_2026-08-29");
    expect(first!.messageCount).toBe(2);
    expect(first!.createdAt).toBe(10_000);

    await repo.upsertMessages(ROOM_ID, [message(3, "message-c", "三通目")]);
    const second = await repo.saveSnapshot(room, "2026-08-29", DEFAULT_FORMAT_OPTIONS, 20_000);
    expect(second!.id).toBe(first!.id);
    expect(second!.messageCount).toBe(3);
    expect(second!.createdAt).toBe(10_000); // 初回作成時刻は保持
    expect(second!.updatedAt).toBe(20_000);

    const list = await repo.listSnapshots();
    expect(list).toHaveLength(1);
  });

  it("日付が変わると別の Snapshot になり、一覧は更新順", async () => {
    const repo = makeRepo();
    await repo.upsertMessages(ROOM_ID, [message(1, "message-a", "本文")]);
    await repo.saveSnapshot(room, "2026-08-28", DEFAULT_FORMAT_OPTIONS, 1_000);
    await repo.saveSnapshot(room, "2026-08-29", DEFAULT_FORMAT_OPTIONS, 2_000);

    const list = await repo.listSnapshots();
    expect(list).toHaveLength(2);
    expect(list[0].date).toBe("2026-08-29"); // updatedAt 降順
    expect(list[1].date).toBe("2026-08-28");
  });

  it("messageKeys から全文を再構成できる (§15)", async () => {
    const repo = makeRepo();
    await repo.upsertMessages(ROOM_ID, [
      message(2, "message-b", "AIの返信"),
      message(1, "message-a", "ユーザーの発言"),
    ]);
    const snap = await repo.saveSnapshot(room, "2026-08-29", DEFAULT_FORMAT_OPTIONS, 1_000);
    expect(snap!.messageKeys).toEqual(["message-a", "message-b"]); // index 順

    const text = await repo.buildSnapshotText(snap!, DEFAULT_FORMAT_OPTIONS);
    expect(text).toBe(
      [
        "[USER: コウ]",
        "",
        "ユーザーの発言",
        "",
        "---",
        "",
        "[AI: 翠]",
        "",
        "[CHARACTER: 翠]",
        "",
        "AIの返信",
      ].join("\n"),
    );
    expect(snap!.characterCount).toBe(text.length);
  });

  it("現在の通し番号や active が変わってもアーカイブの保存時順序を保つ", async () => {
    const repo = makeRepo();
    const a = message(1, "message-a", "発言A");
    const b = message(2, "message-b", "発言B");
    const c = message(3, "message-c", "発言C");
    await repo.upsertMessages(ROOM_ID, [a, b, c]);
    const snap = await repo.saveSnapshot(room, "2026-08-29", DEFAULT_FORMAT_OPTIONS, 1_000);
    await repo.upsertMessages(ROOM_ID, [
      { ...a, index: 3, active: false }, { ...b, index: 2 }, { ...c, index: 1 },
    ]);
    const text = await repo.buildSnapshotText(snap!, DEFAULT_FORMAT_OPTIONS);
    expect(text.indexOf("発言A")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("発言A")).toBeLessThan(text.indexOf("発言B"));
    expect(text.indexOf("発言B")).toBeLessThan(text.indexOf("発言C"));
    expect((await repo.getActiveMessages(ROOM_ID)).map((m) => m.messageKey))
      .toEqual(["message-c", "message-b"]);
  });

  it("メッセージが無い場合は Snapshot を作らない", async () => {
    const repo = makeRepo();
    const snap = await repo.saveSnapshot(room, "2026-08-29", DEFAULT_FORMAT_OPTIONS, 1_000);
    expect(snap).toBeNull();
  });

  it("削除で Snapshot と紐づく要約が消える", async () => {
    const repo = makeRepo();
    await repo.upsertMessages(ROOM_ID, [message(1, "message-a", "本文")]);
    const snap = await repo.saveSnapshot(room, "2026-08-29", DEFAULT_FORMAT_OPTIONS, 1_000);

    const summary: SummaryRecord = {
      id: "sum-1",
      roomId: ROOM_ID,
      snapshotId: snap!.id,
      sourceLabel: snap!.displayName,
      provider: "openai-compatible",
      model: "test-model",
      targetChars: 2000,
      actualChars: 42,
      text: "要約テキスト",
      createdAt: 5_000,
    };
    await repo.saveSummary(summary);
    expect(await repo.listSummariesForSnapshot(snap!.id)).toHaveLength(1);

    await repo.deleteSnapshot(snap!.id);
    expect(await repo.getSnapshot(snap!.id)).toBeNull();
    expect(await repo.listSummariesForSnapshot(snap!.id)).toHaveLength(0);
    expect(await repo.listSnapshots()).toHaveLength(0);
    // メッセージ本体は残る（他 Snapshot から参照されうる）
    expect(await repo.getMessagesForRoom(ROOM_ID)).toHaveLength(1);
  });
});

describe("ArchiveRepository rooms / summaries", () => {
  it("Room は firstSeenAt を保持しつつ lastSeenAt を更新する", async () => {
    const repo = makeRepo();
    const first = await repo.upsertRoom(room, 1_000);
    expect(first.firstSeenAt).toBe(1_000);

    const second = await repo.upsertRoom({ ...room, plotName: "共依存(改)" }, 2_000);
    expect(second.firstSeenAt).toBe(1_000);
    expect(second.lastSeenAt).toBe(2_000);
    expect(second.plotName).toBe("共依存(改)");
  });

  it("Room 単位の要約一覧は作成順（降順）", async () => {
    const repo = makeRepo();
    const base: Omit<SummaryRecord, "id" | "createdAt"> = {
      roomId: ROOM_ID,
      snapshotId: null,
      sourceLabel: "LIVE",
      provider: "openai-compatible",
      model: "m",
      targetChars: 1000,
      actualChars: 900,
      text: "t",
    };
    await repo.saveSummary({ ...base, id: "s1", createdAt: 1_000 });
    await repo.saveSummary({ ...base, id: "s2", createdAt: 3_000 });
    await repo.saveSummary({ ...base, id: "s3", createdAt: 2_000 });

    const list = await repo.listSummariesForRoom(ROOM_ID);
    expect(list.map((s) => s.id)).toEqual(["s2", "s3", "s1"]);
  });
});
