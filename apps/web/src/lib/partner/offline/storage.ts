import type { EncryptedBytes, EncryptedEnvelope } from './crypto';

/**
 * Persistence adapters for the offline store. The IndexedDB adapter is used in
 * the browser; the in-memory adapter backs unit tests and browsers where
 * IndexedDB is unavailable (private windows on some engines), in which case
 * drafts survive only while the page is open and the UI says so.
 */

export interface StoredRecord {
  /** `${userId}|${offlineClientId}` — the namespace is part of the primary key. */
  key: string;
  userId: string;
  offlineClientId: string;
  draftKind: 'visit' | 'report';
  /** Clear-text fields needed to list drafts without decrypting. */
  open: Record<string, unknown>;
  /** Sensitive fields, encrypted with the owner's session key. */
  sealed: EncryptedEnvelope;
  updatedAt: string;
}

export interface StoredBlob {
  /** `${userId}|${offlineClientId}|${photoId}` */
  key: string;
  userId: string;
  offlineClientId: string;
  photoId: string;
  mime: string;
  sealed: EncryptedBytes;
}

export interface DraftStorage {
  readonly persistent: boolean;
  getRecord(key: string): Promise<StoredRecord | undefined>;
  putRecord(record: StoredRecord): Promise<void>;
  deleteRecord(key: string): Promise<void>;
  listRecords(userId: string): Promise<StoredRecord[]>;
  getBlob(key: string): Promise<StoredBlob | undefined>;
  putBlob(blob: StoredBlob): Promise<void>;
  deleteBlob(key: string): Promise<void>;
  deleteBlobsFor(userId: string, offlineClientId: string): Promise<void>;
}

export function recordKey(userId: string, offlineClientId: string): string {
  return `${userId}|${offlineClientId}`;
}

export function blobKey(userId: string, offlineClientId: string, photoId: string): string {
  return `${userId}|${offlineClientId}|${photoId}`;
}

/* ---------------------------------------------------------------------- */
/* In-memory                                                               */
/* ---------------------------------------------------------------------- */

export function createMemoryStorage(): DraftStorage {
  const records = new Map<string, StoredRecord>();
  const blobs = new Map<string, StoredBlob>();
  return {
    persistent: false,
    async getRecord(key) {
      return records.get(key);
    },
    async putRecord(record) {
      records.set(record.key, record);
    },
    async deleteRecord(key) {
      records.delete(key);
    },
    async listRecords(userId) {
      return [...records.values()].filter((r) => r.userId === userId);
    },
    async getBlob(key) {
      return blobs.get(key);
    },
    async putBlob(blob) {
      blobs.set(blob.key, blob);
    },
    async deleteBlob(key) {
      blobs.delete(key);
    },
    async deleteBlobsFor(userId, offlineClientId) {
      for (const [k, b] of blobs) {
        if (b.userId === userId && b.offlineClientId === offlineClientId) blobs.delete(k);
      }
    },
  };
}

/* ---------------------------------------------------------------------- */
/* IndexedDB                                                               */
/* ---------------------------------------------------------------------- */

const DB_NAME = 'sxd-partner-offline';
const DB_VERSION = 1;
const RECORDS = 'drafts';
const BLOBS = 'photo_bytes';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RECORDS)) {
        const s = db.createObjectStore(RECORDS, { keyPath: 'key' });
        s.createIndex('userId', 'userId', { unique: false });
      }
      if (!db.objectStoreNames.contains(BLOBS)) {
        const s = db.createObjectStore(BLOBS, { keyPath: 'key' });
        s.createIndex('userId', 'userId', { unique: false });
        s.createIndex('draft', ['userId', 'offlineClientId'], { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('could not open IndexedDB'));
    req.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
  });
}

export function indexedDbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

export function createIndexedDbStorage(): DraftStorage {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const db = () => {
    dbPromise ??= openDb();
    return dbPromise;
  };
  const tx = async (store: string, mode: IDBTransactionMode) => {
    const d = await db();
    return d.transaction(store, mode).objectStore(store);
  };
  return {
    persistent: true,
    async getRecord(key) {
      return request((await tx(RECORDS, 'readonly')).get(key)) as Promise<StoredRecord | undefined>;
    },
    async putRecord(record) {
      await request((await tx(RECORDS, 'readwrite')).put(record));
    },
    async deleteRecord(key) {
      await request((await tx(RECORDS, 'readwrite')).delete(key));
    },
    async listRecords(userId) {
      const s = await tx(RECORDS, 'readonly');
      return request(s.index('userId').getAll(userId)) as Promise<StoredRecord[]>;
    },
    async getBlob(key) {
      return request((await tx(BLOBS, 'readonly')).get(key)) as Promise<StoredBlob | undefined>;
    },
    async putBlob(blob) {
      await request((await tx(BLOBS, 'readwrite')).put(blob));
    },
    async deleteBlob(key) {
      await request((await tx(BLOBS, 'readwrite')).delete(key));
    },
    async deleteBlobsFor(userId, offlineClientId) {
      const s = await tx(BLOBS, 'readwrite');
      const keys = (await request(
        s.index('draft').getAllKeys([userId, offlineClientId]),
      )) as IDBValidKey[];
      for (const k of keys) await request(s.delete(k));
    },
  };
}
