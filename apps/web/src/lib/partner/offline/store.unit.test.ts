import { describe, expect, it } from 'vitest';
import type { SiteVisitSyncResult } from '@simplexd/contracts';
import { decryptJson, getSessionKey, hasSessionKey, type KeyStore } from './crypto';
import { createMemoryStorage, recordKey } from './storage';
import { createDraftStore } from './store';
import {
  applySyncResult,
  buildSyncItem,
  isDraftFullyConfirmed,
  syncVisitDraft,
  type SyncDeps,
} from './sync';
import type { PhotoDraft, VisitDraft } from './types';

function memoryKeyStore(): KeyStore {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

function photo(over: Partial<PhotoDraft> = {}): PhotoDraft {
  return {
    id: 'p1',
    name: 'front.jpg',
    mime: 'image/jpeg',
    sizeBytes: 3,
    capturedAt: '2026-09-23T09:00:00.000Z',
    caption: '',
    fileId: null,
    evidenceId: null,
    state: 'pending',
    reason: null,
    retryable: false,
    ...over,
  };
}

function visit(over: Partial<VisitDraft> = {}): VisitDraft {
  return {
    kind: 'visit',
    offlineClientId: 'visit_abc12345',
    userId: 'user-a',
    projectId: '6f1d2a3b-0000-4000-8000-000000000001',
    siteVisitId: null,
    title: 'Lekki plot 12',
    instructions: 'Check the trench depth',
    findingsMarkdown: 'Foundation trench flooded after rain.',
    checklist: [{ key: 'access', label: 'Access confirmed', checked: true, note: 'Gateman: Musa' }],
    weather: 'Rain',
    accessNote: 'Call the gateman on arrival',
    gps: {
      lat: 6.45,
      lon: 3.47,
      accuracyM: 12,
      capturedAt: '2026-09-23T09:01:00.000Z',
      source: 'device_user_provided',
    },
    photos: [],
    startedAt: '2026-09-23T08:55:00.000Z',
    submittedAt: null,
    createdAt: '2026-09-23T08:55:00.000Z',
    updatedAt: '2026-09-23T09:05:00.000Z',
    syncState: 'unsynced',
    serverVisitId: null,
    lastSyncAt: null,
    lastSyncError: null,
    ...over,
  };
}

describe('offline draft store', () => {
  it('encrypts sensitive fields and round-trips them for the owner', async () => {
    const storage = createMemoryStorage();
    const keys = memoryKeyStore();
    const key = await getSessionKey('user-a', keys);
    const store = createDraftStore({ userId: 'user-a', key, storage });
    await store.put(visit());
    const raw = await storage.getRecord(recordKey('user-a', 'visit_abc12345'));
    expect(raw).toBeDefined();
    const rawText = JSON.stringify(raw);
    expect(rawText).not.toContain('Foundation trench');
    expect(rawText).not.toContain('gateman');
    expect(rawText).not.toContain('6.45');
    expect(raw!.open.title).toBe('Lekki plot 12');
    const back = await store.get('visit_abc12345');
    expect(back?.kind).toBe('visit');
    expect(back).toMatchObject({
      findingsMarkdown: 'Foundation trench flooded after rain.',
      gps: { lat: 6.45 },
    });
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    await store.putPhotoBytes('visit_abc12345', 'p1', 'image/jpeg', bytes);
    const stored = await storage.getBlob('user-a|visit_abc12345|p1');
    expect(Array.from(new Uint8Array(stored!.sealed.data))).not.toEqual([1, 2, 3]);
    const got = await store.getPhotoBytes('visit_abc12345', 'p1');
    expect(Array.from(new Uint8Array(got!.bytes))).toEqual([1, 2, 3]);
  });

  it("never exposes one user's drafts to another user on the same device", async () => {
    const storage = createMemoryStorage();
    const keys = memoryKeyStore();
    const keyA = await getSessionKey('user-a', keys);
    const storeA = createDraftStore({ userId: 'user-a', key: keyA, storage });
    await storeA.put(visit());
    await storeA.putPhotoBytes('visit_abc12345', 'p1', 'image/jpeg', new Uint8Array([9]).buffer);

    // A second sign-in on the same browser: same storage, a different user and key.
    const keyB = await getSessionKey('user-b', keys);
    const storeB = createDraftStore({ userId: 'user-b', key: keyB, storage });
    expect(await storeB.list()).toEqual([]);
    expect(await storeB.get('visit_abc12345')).toBeNull();
    expect(await storeB.getPhotoBytes('visit_abc12345', 'p1')).toBeNull();

    // Even reaching past the namespace, user B's key cannot open A's record.
    const raw = (await storage.getRecord(recordKey('user-a', 'visit_abc12345')))!;
    await expect(decryptJson(keyB!, raw.sealed)).rejects.toBeDefined();
    // And a store for user B pointed at A's record reports it as locked, not as content.
    const impostor = createDraftStore({ userId: 'user-a', key: keyB, storage });
    const seen = await impostor.get('visit_abc12345');
    expect(seen?.kind).toBe('locked');
  });

  it('reports drafts as locked when the session key is gone and refuses to save without one', async () => {
    const storage = createMemoryStorage();
    const keys = memoryKeyStore();
    const key = await getSessionKey('user-a', keys);
    await createDraftStore({ userId: 'user-a', key, storage }).put(visit());
    // New browser session: sessionStorage is empty, so a fresh key is minted.
    const newKeys = memoryKeyStore();
    expect(hasSessionKey('user-a', newKeys)).toBe(false);
    const later = createDraftStore({
      userId: 'user-a',
      key: await getSessionKey('user-a', newKeys),
      storage,
    });
    const [entry] = await later.list();
    expect(entry?.kind).toBe('locked');
    const noKey = createDraftStore({ userId: 'user-a', key: null, storage });
    await expect(noKey.put(visit({ offlineClientId: 'visit_other123' }))).rejects.toThrow(
      /session key/,
    );
  });
});

describe('sync result handling', () => {
  const at = '2026-09-23T10:00:00.000Z';

  it('treats created and replayed alike and folds per-file outcomes', () => {
    const d = visit({
      photos: [
        photo({ id: 'p1', fileId: 'f1', state: 'uploaded' }),
        photo({ id: 'p2', fileId: 'f2', state: 'uploaded' }),
      ],
    });
    const result: SiteVisitSyncResult = {
      offlineClientId: d.offlineClientId,
      outcome: 'replayed',
      siteVisitId: '6f1d2a3b-0000-4000-8000-0000000000aa',
      code: null,
      reason: null,
      evidence: [
        {
          fileId: 'f1',
          outcome: 'replayed',
          evidenceId: '6f1d2a3b-0000-4000-8000-0000000000e1',
          reason: null,
        },
        {
          fileId: 'f2',
          outcome: 'rejected',
          evidenceId: null,
          reason: 'the file has not passed malware scanning yet',
        },
      ],
    };
    const next = applySyncResult(d, result, at);
    expect(next.serverVisitId).toBe(result.siteVisitId);
    expect(next.syncState).toBe('partial');
    expect(next.photos[0]).toMatchObject({
      state: 'linked',
      evidenceId: result.evidence[0]!.evidenceId,
    });
    expect(next.photos[1]).toMatchObject({ state: 'uploaded', retryable: true });
    expect(isDraftFullyConfirmed(next)).toBe(false);
    const done = applySyncResult(
      next,
      {
        ...result,
        outcome: 'replayed',
        evidence: [
          {
            fileId: 'f2',
            outcome: 'created',
            evidenceId: '6f1d2a3b-0000-4000-8000-0000000000e2',
            reason: null,
          },
        ],
      },
      at,
    );
    expect(done.syncState).toBe('synced');
    expect(isDraftFullyConfirmed(done)).toBe(true);
  });

  it('keeps a rejected visit on the device with the server reason', () => {
    const next = applySyncResult(
      visit(),
      {
        offlineClientId: 'visit_abc12345',
        outcome: 'rejected',
        siteVisitId: null,
        code: 'forbidden',
        reason: 'partner is not assigned to this resource',
        evidence: [],
      },
      at,
    );
    expect(next.syncState).toBe('rejected');
    expect(next.lastSyncError).toEqual({
      code: 'forbidden',
      reason: 'partner is not assigned to this resource',
    });
  });

  it('builds a sync item that carries GPS as labelled user-provided data and only uploaded files', () => {
    const item = buildSyncItem(
      visit({ photos: [photo({ fileId: 'f1', state: 'uploaded' }), photo({ id: 'p2' })] }),
    );
    expect(item.projectId).toBeDefined();
    expect(item.siteVisitId).toBeUndefined();
    expect(item.evidenceFileIds).toEqual(['f1']);
    expect((item.checklist as { capture: { gps: { note: string } } }).capture.gps.note).toMatch(
      /not proof/i,
    );
  });

  it('uploads each photo once, links idempotently and clears the draft only after confirmation', async () => {
    const storage = createMemoryStorage();
    const key = await getSessionKey('user-a', memoryKeyStore());
    const store = createDraftStore({ userId: 'user-a', key, storage });
    const siteVisitId = '6f1d2a3b-0000-4000-8000-0000000000aa';
    const draft = visit({
      siteVisitId,
      photos: [
        photo({ id: 'p1' }),
        photo({ id: 'p2', fileId: 'f2', state: 'uploaded', retryable: true }),
      ],
    });
    await store.put(draft);
    await store.putPhotoBytes(
      draft.offlineClientId,
      'p1',
      'image/jpeg',
      new Uint8Array([1, 2, 3]).buffer,
    );
    const calls: string[] = [];
    let uploads = 0;
    let scanPending = true;
    const api: SyncDeps['api'] = async <T>(path: string, init?: { body?: unknown }) => {
      calls.push(path);
      if (path === '/api/v1/files/upload-intents') {
        return {
          fileId: 'f1',
          status: 'pending_upload',
          expiresAt: at,
          upload: { kind: 'single', method: 'PUT', url: 'https://s3.local/f1', headers: {} },
        } as T;
      }
      if (path === '/api/v1/files/f1/finalize')
        return { outcome: 'scanning', file: { statusReason: null } } as T;
      if (path.endsWith('/evidence')) {
        const body = init?.body as { fileId: string; offlineClientId: string };
        expect(body.offlineClientId).toBe(
          `${draft.offlineClientId}.${body.fileId === 'f1' ? 'p1' : 'p2'}`,
        );
        if (body.fileId === 'f2' && scanPending) {
          throw Object.assign(new Error('the file has not passed malware scanning yet'), {
            code: 'file_quarantined',
          });
        }
        return { id: `ev-${body.fileId}`, idempotentReplay: false } as T;
      }
      if (path === '/api/v1/site-visits/sync') {
        const item = (init?.body as { items: Array<{ evidenceFileIds: string[] }> }).items[0]!;
        return {
          results: [
            {
              offlineClientId: draft.offlineClientId,
              outcome: 'created',
              siteVisitId,
              code: null,
              reason: null,
              evidence: item.evidenceFileIds.map((fileId) => ({
                fileId,
                outcome: fileId === 'f2' && scanPending ? 'rejected' : 'replayed',
                evidenceId: fileId === 'f2' && scanPending ? null : `ev-${fileId}`,
                reason:
                  fileId === 'f2' && scanPending
                    ? 'the file has not passed malware scanning yet'
                    : null,
              })),
            },
          ],
        } as T;
      }
      throw new Error(`unexpected ${path}`);
    };
    const deps: SyncDeps = {
      api,
      uploadBytes: async () => {
        uploads += 1;
      },
      store,
      now: () => new Date(at),
      isOnline: () => true,
    };
    const first = await syncVisitDraft(draft, deps);
    expect(uploads).toBe(1);
    expect(first.cleared).toBe(false);
    expect(first.visitOutcome).toBe('created');
    expect(first.draft.syncState).toBe('partial');
    expect(first.draft.photos.find((p) => p.id === 'p1')).toMatchObject({
      fileId: 'f1',
      state: 'linked',
    });
    expect(first.draft.photos.find((p) => p.id === 'p2')).toMatchObject({
      state: 'uploaded',
      retryable: true,
    });
    expect((await store.get(draft.offlineClientId))?.kind).toBe('visit');

    // Second attempt after the scan: no new upload, p1 is not re-linked, and the draft clears.
    scanPending = false;
    calls.length = 0;
    const second = await syncVisitDraft(first.draft, deps);
    expect(uploads).toBe(1);
    expect(calls.filter((c) => c === '/api/v1/files/upload-intents')).toHaveLength(0);
    expect(calls.filter((c) => c.endsWith('/evidence'))).toHaveLength(1);
    expect(second.cleared).toBe(true);
    expect(await store.get(draft.offlineClientId)).toBeNull();
    expect(await storage.getBlob('user-a|visit_abc12345|p1')).toBeUndefined();
  });

  it('keeps the draft intact when the network fails mid-way', async () => {
    const storage = createMemoryStorage();
    const key = await getSessionKey('user-a', memoryKeyStore());
    const store = createDraftStore({ userId: 'user-a', key, storage });
    const draft = visit();
    await store.put(draft);
    const outcome = await syncVisitDraft(draft, {
      api: async () => {
        throw new TypeError('Failed to fetch');
      },
      uploadBytes: async () => undefined,
      store,
      isOnline: () => true,
    });
    expect(outcome.cleared).toBe(false);
    expect(outcome.draft.syncState).toBe('unsynced');
    expect(outcome.draft.lastSyncError?.reason).toBe('Failed to fetch');
    expect((await store.get(draft.offlineClientId))?.kind).toBe('visit');
  });
});
