/**
 * IndexedDB ラッパ (§15)。
 * Database: zetaLogCompanion / Stores: rooms, messages, snapshots, summaries
 */

export const DB_NAME = "zetaLogCompanion";
/**
 * v2: MessageRecord.index の意味が「data-index 由来」から
 * 「拡張側で振り直す時系列通し番号」へ変わったため、
 * v1 の（順序が壊れている可能性のある）データは引き継がず全クリアする。
 */
export const DB_VERSION = 2;

export const STORE_ROOMS = "rooms";
export const STORE_MESSAGES = "messages";
export const STORE_SNAPSHOTS = "snapshots";
export const STORE_SUMMARIES = "summaries";

export function openDatabase(name: string = DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = req.result;
      const upgradeTx = req.transaction;

      // v1 → v2: index の意味が変わったため既存データをクリアする
      if (event.oldVersion > 0 && event.oldVersion < 2 && upgradeTx) {
        for (const storeName of Array.from(db.objectStoreNames)) {
          upgradeTx.objectStore(storeName).clear();
        }
      }

      if (!db.objectStoreNames.contains(STORE_ROOMS)) {
        db.createObjectStore(STORE_ROOMS, { keyPath: "roomId" });
      }

      if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
        const messages = db.createObjectStore(STORE_MESSAGES, {
          keyPath: ["roomId", "messageKey"],
        });
        messages.createIndex("byRoom", "roomId", { unique: false });
        messages.createIndex("byRoomIndex", ["roomId", "index"], {
          unique: false,
        });
      }

      if (!db.objectStoreNames.contains(STORE_SNAPSHOTS)) {
        const snapshots = db.createObjectStore(STORE_SNAPSHOTS, {
          keyPath: "id",
        });
        snapshots.createIndex("byRoom", "roomId", { unique: false });
        snapshots.createIndex("byUpdatedAt", "updatedAt", { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_SUMMARIES)) {
        const summaries = db.createObjectStore(STORE_SUMMARIES, {
          keyPath: "id",
        });
        summaries.createIndex("byRoom", "roomId", { unique: false });
        summaries.createIndex("bySnapshot", "snapshotId", { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

export function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}
