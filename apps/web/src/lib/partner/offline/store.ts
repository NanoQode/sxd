import { decryptBytes, decryptJson, encryptBytes, encryptJson } from './crypto';
import { blobKey, recordKey, type DraftStorage, type StoredRecord } from './storage';
import {
  REPORT_PUBLIC_FIELDS,
  VISIT_PUBLIC_FIELDS,
  type Draft,
  type LockedDraft,
  type ReportDraft,
  type VisitDraft,
} from './types';

/**
 * Per-user offline draft store.
 *
 * Every record is namespaced by the signed-in user's id (the id is part of the
 * primary key and the listing index), and its sensitive fields are sealed with
 * that user's session key. A different user on the same device therefore sees
 * no records from a listing, and a record read outside the listing cannot be
 * decrypted with their key. A record whose key is gone (new browser session)
 * is reported as `LockedDraft` rather than silently dropped.
 */

export interface DraftStore {
  readonly userId: string;
  readonly persistent: boolean;
  readonly canSeal: boolean;
  list(): Promise<Array<Draft | LockedDraft>>;
  get(offlineClientId: string): Promise<Draft | LockedDraft | null>;
  put(draft: Draft): Promise<void>;
  delete(offlineClientId: string): Promise<void>;
  putPhotoBytes(offlineClientId: string, photoId: string, mime: string, bytes: ArrayBuffer): Promise<void>;
  getPhotoBytes(offlineClientId: string, photoId: string): Promise<{ mime: string; bytes: ArrayBuffer } | null>;
  deletePhotoBytes(offlineClientId: string, photoId: string): Promise<void>;
}

function split<T extends Draft>(
  draft: T,
  publicFields: readonly (keyof T)[],
): { open: Record<string, unknown>; sensitive: Record<string, unknown> } {
  const open: Record<string, unknown> = {};
  const sensitive: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(draft)) {
    if ((publicFields as readonly string[]).includes(k)) open[k] = v;
    else sensitive[k] = v;
  }
  return { open, sensitive };
}

function toLocked(record: StoredRecord): LockedDraft {
  return {
    kind: 'locked',
    offlineClientId: record.offlineClientId,
    userId: record.userId,
    draftKind: record.draftKind,
    title: String(record.open.title ?? 'Untitled draft'),
    updatedAt: record.updatedAt,
    syncState: (record.open.syncState as LockedDraft['syncState']) ?? 'unsynced',
  };
}

export function createDraftStore(options: {
  userId: string;
  key: CryptoKey | null;
  storage: DraftStorage;
}): DraftStore {
  const { userId, key, storage } = options;

  async function open(record: StoredRecord): Promise<Draft | LockedDraft> {
    if (record.userId !== userId) {
      // Defensive: listings are already filtered, but never hand another user's record out.
      return toLocked(record);
    }
    if (!key) return toLocked(record);
    try {
      const sensitive = await decryptJson<Record<string, unknown>>(key, record.sealed);
      return { ...record.open, ...sensitive } as Draft;
    } catch {
      return toLocked(record);
    }
  }

  return {
    userId,
    persistent: storage.persistent,
    canSeal: key !== null,
    async list() {
      const records = await storage.listRecords(userId);
      const out: Array<Draft | LockedDraft> = [];
      for (const r of records) out.push(await open(r));
      return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    },
    async get(offlineClientId) {
      const r = await storage.getRecord(recordKey(userId, offlineClientId));
      return r ? open(r) : null;
    },
    async put(draft) {
      if (!key) {
        throw new Error(
          'Cannot save the draft: no session key is available, so sensitive fields would be stored in clear text.',
        );
      }
      if (draft.userId !== userId) throw new Error('draft belongs to a different user');
      const { open: openFields, sensitive } =
        draft.kind === 'visit'
          ? split<VisitDraft>(draft, VISIT_PUBLIC_FIELDS)
          : split<ReportDraft>(draft, REPORT_PUBLIC_FIELDS);
      await storage.putRecord({
        key: recordKey(userId, draft.offlineClientId),
        userId,
        offlineClientId: draft.offlineClientId,
        draftKind: draft.kind,
        open: openFields,
        sealed: await encryptJson(key, sensitive),
        updatedAt: draft.updatedAt,
      });
    },
    async delete(offlineClientId) {
      await storage.deleteBlobsFor(userId, offlineClientId);
      await storage.deleteRecord(recordKey(userId, offlineClientId));
    },
    async putPhotoBytes(offlineClientId, photoId, mime, bytes) {
      if (!key) throw new Error('no session key: photos cannot be stored');
      await storage.putBlob({
        key: blobKey(userId, offlineClientId, photoId),
        userId,
        offlineClientId,
        photoId,
        mime,
        sealed: await encryptBytes(key, bytes),
      });
    },
    async getPhotoBytes(offlineClientId, photoId) {
      const b = await storage.getBlob(blobKey(userId, offlineClientId, photoId));
      if (!b || b.userId !== userId || !key) return null;
      try {
        return { mime: b.mime, bytes: await decryptBytes(key, b.sealed) };
      } catch {
        return null;
      }
    },
    async deletePhotoBytes(offlineClientId, photoId) {
      await storage.deleteBlob(blobKey(userId, offlineClientId, photoId));
    },
  };
}
