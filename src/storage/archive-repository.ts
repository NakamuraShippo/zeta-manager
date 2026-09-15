/**
 * rooms / messages / snapshots / summaries の永続化 (§14 / §15)。
 * service worker からのみ使用する。
 */

import {
  STORE_MESSAGES,
  STORE_ROOMS,
  STORE_SNAPSHOTS,
  STORE_SUMMARIES,
  requestToPromise,
  transactionDone,
} from "./database";
import type {
  FormatOptions,
  MessageRecord,
  RoomInfo,
  RoomRecord,
  SnapshotRecord,
  SummaryRecord,
} from "../shared/types";
import { formatTranscript } from "../shared/text-format";
import { countChars } from "../shared/utils";

export function snapshotIdOf(roomId: string, date: string): string {
  return `${roomId}:${date}`;
}

export class ArchiveRepository {
  constructor(private readonly dbPromise: Promise<IDBDatabase>) {}

  private db(): Promise<IDBDatabase> {
    return this.dbPromise;
  }

  async upsertRoom(room: RoomInfo, now: number): Promise<RoomRecord> {
    const db = await this.db();
    const tx = db.transaction(STORE_ROOMS, "readwrite");
    const store = tx.objectStore(STORE_ROOMS);
    const existing = (await requestToPromise(store.get(room.roomId))) as
      | RoomRecord
      | undefined;
    const record: RoomRecord = {
      roomId: room.roomId,
      plotName: room.plotName || existing?.plotName || "",
      url: room.url || existing?.url || "",
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
    };
    store.put(record);
    await transactionDone(tx);
    return record;
  }

  /**
   * メッセージ差分を保存する。
   * 順序 (index) と active フラグは content script 側の ConversationStore が
   * 一元管理して確定済みの値を送ってくるため、ここではそれを信頼して
   * そのまま永続化する（capturedAt のみ初回値を保持）。
   */
  async upsertMessages(roomId: string, records: MessageRecord[]): Promise<void> {
    if (records.length === 0) return;
    const db = await this.db();
    const tx = db.transaction(STORE_MESSAGES, "readwrite");
    const store = tx.objectStore(STORE_MESSAGES);

    for (const incoming of records) {
      if (incoming.roomId !== roomId) continue;
      const existing = (await requestToPromise(
        store.get([roomId, incoming.messageKey]),
      )) as MessageRecord | undefined;
      const merged: MessageRecord = existing
        ? {
            ...existing,
            index: incoming.index,
            role: incoming.role,
            speaker: incoming.speaker,
            parts: incoming.parts,
            contentHash: incoming.contentHash,
            updatedAt: incoming.updatedAt,
            active: incoming.active,
          }
        : incoming;
      store.put(merged);
    }

    await transactionDone(tx);
  }

  async getMessagesForRoom(roomId: string): Promise<MessageRecord[]> {
    const db = await this.db();
    const tx = db.transaction(STORE_MESSAGES, "readonly");
    const index = tx.objectStore(STORE_MESSAGES).index("byRoom");
    const all = (await requestToPromise(index.getAll(roomId))) as MessageRecord[];
    await transactionDone(tx);
    return all;
  }

  async getActiveMessages(roomId: string): Promise<MessageRecord[]> {
    const all = await this.getMessagesForRoom(roomId);
    return all.filter((m) => m.active).sort((a, b) => a.index - b.index);
  }

  /**
   * 自動保存 (§14)。同一 Room・同一日付では同じ Snapshot を更新する。
   * 全文は複製せず messageKeys から再構成できる形で保持する (§15)。
   */
  async saveSnapshot(
    room: RoomInfo,
    date: string,
    format: FormatOptions,
    now: number,
  ): Promise<SnapshotRecord | null> {
    await this.upsertRoom(room, now);
    const active = await this.getActiveMessages(room.roomId);
    if (active.length === 0) return null;

    const text = formatTranscript(active, format);
    const id = snapshotIdOf(room.roomId, date);

    const db = await this.db();
    const tx = db.transaction(STORE_SNAPSHOTS, "readwrite");
    const store = tx.objectStore(STORE_SNAPSHOTS);
    const existing = (await requestToPromise(store.get(id))) as
      | SnapshotRecord
      | undefined;

    const record: SnapshotRecord = {
      id,
      roomId: room.roomId,
      date,
      displayName: `${room.plotName || "無題"}_${date}`,
      messageKeys: active.map((m) => m.messageKey),
      messageCount: active.length,
      characterCount: countChars(text),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    store.put(record);
    await transactionDone(tx);
    return record;
  }

  async listSnapshots(): Promise<SnapshotRecord[]> {
    const db = await this.db();
    const tx = db.transaction(STORE_SNAPSHOTS, "readonly");
    const all = (await requestToPromise(
      tx.objectStore(STORE_SNAPSHOTS).getAll(),
    )) as SnapshotRecord[];
    await transactionDone(tx);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getSnapshot(id: string): Promise<SnapshotRecord | null> {
    const db = await this.db();
    const tx = db.transaction(STORE_SNAPSHOTS, "readonly");
    const rec = (await requestToPromise(tx.objectStore(STORE_SNAPSHOTS).get(id))) as
      | SnapshotRecord
      | undefined;
    await transactionDone(tx);
    return rec ?? null;
  }

  /** Snapshot の messageKeys から全文を再構成する (§15)。 */
  async buildSnapshotText(
    snapshot: SnapshotRecord,
    format: FormatOptions,
  ): Promise<string> {
    const db = await this.db();
    const tx = db.transaction(STORE_MESSAGES, "readonly");
    const store = tx.objectStore(STORE_MESSAGES);
    const records: MessageRecord[] = [];
    for (const key of snapshot.messageKeys) {
      const rec = (await requestToPromise(store.get([snapshot.roomId, key]))) as
        | MessageRecord
        | undefined;
      // 現在の index は再同期で変わるため、保存時の messageKeys 順を使う。
      if (rec) records.push({ ...rec, active: true, index: records.length + 1 });
    }
    await transactionDone(tx);
    return formatTranscript(records, format);
  }

  async deleteSnapshot(id: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction([STORE_SNAPSHOTS, STORE_SUMMARIES], "readwrite");
    tx.objectStore(STORE_SNAPSHOTS).delete(id);
    const bySnapshot = tx.objectStore(STORE_SUMMARIES).index("bySnapshot");
    const summaries = (await requestToPromise(bySnapshot.getAll(id))) as
      SummaryRecord[];
    for (const s of summaries) {
      tx.objectStore(STORE_SUMMARIES).delete(s.id);
    }
    await transactionDone(tx);
  }

  async saveSummary(summary: SummaryRecord): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE_SUMMARIES, "readwrite");
    tx.objectStore(STORE_SUMMARIES).put(summary);
    await transactionDone(tx);
  }

  async listSummariesForRoom(roomId: string): Promise<SummaryRecord[]> {
    const db = await this.db();
    const tx = db.transaction(STORE_SUMMARIES, "readonly");
    const all = (await requestToPromise(
      tx.objectStore(STORE_SUMMARIES).index("byRoom").getAll(roomId),
    )) as SummaryRecord[];
    await transactionDone(tx);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  async listSummariesForSnapshot(snapshotId: string): Promise<SummaryRecord[]> {
    const db = await this.db();
    const tx = db.transaction(STORE_SUMMARIES, "readonly");
    const all = (await requestToPromise(
      tx.objectStore(STORE_SUMMARIES).index("bySnapshot").getAll(snapshotId),
    )) as SummaryRecord[];
    await transactionDone(tx);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }
}
