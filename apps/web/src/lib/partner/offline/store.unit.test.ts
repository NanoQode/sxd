import { describe, expect, it } from 'vitest';
import type { SiteVisitSyncItem, SiteVisitSyncResult } from '@simplexd/contracts';
import { ApiClientError } from '@/lib/api/client-fetch';
import {
  decryptJson,
  getSessionKey,
  hasSessionKey,
  purgeOtherSessionKeys,
  type KeyStore,
} from './crypto';
import { createMemoryStorage, recordKey, type DraftStorage } from './storage';
import { createDraftStore, type DraftStore } from './store';
import {
  OfflineError,
  applySyncResult,
  buildSyncItem,
  classifyFailure,
  evidenceOfflineId,
  isDraftFullyConfirmed,
  syncReportDraft,
  syncVisitDraft,
  type SyncDeps,
} from './sync';
import type { PhotoDraft, ReportDraft, VisitDraft } from './types';

function memoryKeyStore(): KeyStore {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i) => [...m.keys()][i] ?? null,
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

describe('session keys on a shared device', () => {
  it("purges another user's key left in the tab, so their drafts stay sealed", async () => {
    const storage = createMemoryStorage();
    const keys = memoryKeyStore();
    keys.setItem('unrelated', 'kept');
    const keyA = await getSessionKey('user-a', keys);
    await createDraftStore({ userId: 'user-a', key: keyA, storage }).put(visit());
    // User A's session expires without sign-out; user B opens the workspace in the same tab.
    expect(purgeOtherSessionKeys('user-b', keys)).toBe(1);
    expect(hasSessionKey('user-a', keys)).toBe(false);
    expect(keys.getItem('unrelated')).toBe('kept');
    // Even user A's own store, re-created later in this tab, now sees a locked draft.
    const later = createDraftStore({
      userId: 'user-a',
      key: await getSessionKey('user-a', keys),
      storage,
    });
    expect((await later.list())[0]?.kind).toBe('locked');
  });
});

/* -------------------------------------------------------------------------- */
/* Sync against a fake server that keys records the way the real one does      */
/* -------------------------------------------------------------------------- */

const PROJECT = '6f1d2a3b-0000-4000-8000-000000000001';
const SCHEDULED = '6f1d2a3b-0000-4000-8000-0000000000aa';
const at = '2026-09-23T10:00:00.000Z';

function apiError(status: number, code: string, message: string) {
  return new ApiClientError(status, { error: { code, message, correlationId: 'corr-1' } });
}

/**
 * Mirrors the server contracts that matter for duplicates: visits replay on
 * their offline id, evidence replays on its offline id (the server's own
 * site-visit sync links files as `${offlineClientId}:${fileId}`), files are
 * quarantined until "scanned".
 */
function fakeServer() {
  const visits = new Map<string, { id: string; submits: number }>();
  const evidence = new Map<string, { id: string; fileId: string; caption: string | null }>();
  const fileStatus = new Map<string, 'scanning' | 'clean' | 'infected'>();
  const calls: string[] = [];
  let nextFile = 0;
  let failNext: ((path: string) => Error | null) | null = null;
  let dropResponseOf: string | null = null;

  function linkEvidence(body: {
    fileId: string;
    offlineClientId: string;
    caption?: string | null;
  }) {
    const existing = evidence.get(body.offlineClientId);
    if (existing) return { ...existing, idempotentReplay: true };
    const status = fileStatus.get(body.fileId);
    if (status === 'scanning')
      throw apiError(409, 'file_quarantined', 'the file has not passed malware scanning yet');
    if (status !== 'clean') throw apiError(422, 'file_rejected', `the file is ${status}`);
    const row = {
      id: `ev-${evidence.size + 1}`,
      fileId: body.fileId,
      caption: body.caption ?? null,
    };
    evidence.set(body.offlineClientId, row);
    return { ...row, idempotentReplay: false };
  }

  const api: SyncDeps['api'] = async <T>(path: string, init?: { body?: unknown }) => {
    calls.push(path);
    const injected = failNext?.(path) ?? null;
    if (injected) {
      failNext = null;
      throw injected;
    }
    let response: unknown;
    if (path === '/api/v1/files/upload-intents') {
      nextFile += 1;
      const fileId = `00000000-0000-4000-8000-${String(nextFile).padStart(12, '0')}`;
      fileStatus.set(fileId, 'scanning');
      response = {
        fileId,
        status: 'pending_upload',
        expiresAt: at,
        upload: { kind: 'single', method: 'PUT', url: `https://s3.local/${fileId}`, headers: {} },
      };
    } else if (/\/api\/v1\/files\/.+\/finalize$/.test(path)) {
      response = { outcome: 'scanning', file: { statusReason: null } };
    } else if (path === `/api/v1/projects/${PROJECT}/evidence`) {
      response = linkEvidence(init?.body as { fileId: string; offlineClientId: string });
    } else if (path === '/api/v1/site-visits/sync') {
      const item = (init?.body as { items: SiteVisitSyncItem[] }).items[0]!;
      const existing = visits.get(item.offlineClientId);
      const id = existing?.id ?? item.siteVisitId ?? SCHEDULED.replace('aa', 'bb');
      visits.set(item.offlineClientId, { id, submits: (existing?.submits ?? 0) + 1 });
      const linked = item.evidenceFileIds.map((fileId) => {
        try {
          const r = linkEvidence({ fileId, offlineClientId: `${item.offlineClientId}:${fileId}` });
          return {
            fileId,
            outcome: r.idempotentReplay ? ('replayed' as const) : ('created' as const),
            evidenceId: r.id,
            reason: null,
          };
        } catch (err) {
          return {
            fileId,
            outcome: 'rejected' as const,
            evidenceId: null,
            reason: (err as Error).message,
          };
        }
      });
      response = {
        results: [
          {
            offlineClientId: item.offlineClientId,
            outcome: existing ? 'replayed' : 'created',
            siteVisitId: id,
            code: null,
            reason: null,
            evidence: linked,
          },
        ],
      };
    } else {
      throw new Error(`unexpected ${path}`);
    }
    if (dropResponseOf && path === dropResponseOf) {
      dropResponseOf = null;
      throw new TypeError('Failed to fetch');
    }
    return response as T;
  };

  return {
    api,
    calls,
    visits,
    evidence,
    scanAll(status: 'clean' | 'infected' = 'clean') {
      for (const k of fileStatus.keys()) fileStatus.set(k, status);
    },
    failOnce(fn: (path: string) => Error | null) {
      failNext = fn;
    },
    /** The server processes the request but the response never reaches the device. */
    loseResponseOf(path: string) {
      dropResponseOf = path;
    },
  };
}

async function draftWithPhotos(
  over: Partial<VisitDraft>,
  photoIds: string[],
): Promise<{ store: DraftStore; storage: DraftStorage; draft: VisitDraft }> {
  const storage = createMemoryStorage();
  const key = await getSessionKey('user-a', memoryKeyStore());
  const store = createDraftStore({ userId: 'user-a', key, storage });
  const draft = visit({
    ...over,
    photos: photoIds.map((id) => photo({ id, caption: `caption ${id}` })),
  });
  await store.put(draft);
  for (const id of photoIds) {
    await store.putPhotoBytes(draft.offlineClientId, id, 'image/jpeg', new Uint8Array([1]).buffer);
  }
  return { store, storage, draft };
}

function depsFor(server: ReturnType<typeof fakeServer>, store: DraftStore) {
  let uploads = 0;
  const deps: SyncDeps = {
    api: server.api,
    uploadBytes: async () => {
      uploads += 1;
    },
    store,
    now: () => new Date(at),
    isOnline: () => true,
  };
  return { deps, uploads: () => uploads };
}

describe('sync result handling', () => {
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
      siteVisitId: SCHEDULED,
      code: null,
      reason: null,
      evidence: [
        { fileId: 'f1', outcome: 'replayed', evidenceId: 'e1', reason: null },
        {
          fileId: 'f2',
          outcome: 'rejected',
          evidenceId: null,
          reason: 'the file has not passed malware scanning yet',
        },
      ],
    };
    const next = applySyncResult(d, result, at);
    expect(next.serverVisitId).toBe(SCHEDULED);
    expect(next.syncState).toBe('partial');
    expect(next.photos[0]).toMatchObject({ state: 'linked', evidenceId: 'e1' });
    expect(next.photos[1]).toMatchObject({ state: 'uploaded', retryable: true });
    expect(isDraftFullyConfirmed(next)).toBe(false);
    const done = applySyncResult(
      next,
      {
        ...result,
        evidence: [{ fileId: 'f2', outcome: 'created', evidenceId: 'e2', reason: null }],
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
    expect(isDraftFullyConfirmed(next)).toBe(false);
  });

  it('builds a sync item with GPS labelled as user-provided and links photos separately', () => {
    const item = buildSyncItem(visit({ photos: [photo({ fileId: 'f1', state: 'uploaded' })] }));
    expect(item.projectId).toBe(PROJECT);
    expect(item.siteVisitId).toBeUndefined();
    expect(item.evidenceFileIds).toEqual([]);
    expect((item.checklist as { capture: { gps: { note: string } } }).capture.gps.note).toMatch(
      /not proof/i,
    );
    expect(buildSyncItem(visit({ siteVisitId: SCHEDULED })).siteVisitId).toBe(SCHEDULED);
  });

  it('uses the same evidence key as the server so the two link paths cannot duplicate', () => {
    expect(evidenceOfflineId('visit_abc12345', 'f1')).toBe('visit_abc12345:f1');
  });

  it('classifies failures: only definitive API refusals reject', () => {
    expect(classifyFailure(new TypeError('Failed to fetch'))).toBe('transient');
    expect(classifyFailure(apiError(503, 'internal_error', 'down'))).toBe('transient');
    expect(classifyFailure(apiError(401, 'unauthenticated', 'expired'))).toBe('transient');
    expect(classifyFailure(apiError(429, 'rate_limited', 'slow down'))).toBe('transient');
    expect(classifyFailure(apiError(409, 'file_quarantined', 'scan'))).toBe('quarantined');
    expect(classifyFailure(apiError(422, 'file_rejected', 'infected'))).toBe('definitive');
    expect(classifyFailure(apiError(403, 'forbidden', 'no'))).toBe('definitive');
  });
});

describe('syncVisitDraft', () => {
  it('scheduled visit: uploads once, links with metadata, replays, clears only when all photos are linked', async () => {
    const server = fakeServer();
    const { store, storage, draft } = await draftWithPhotos({ siteVisitId: SCHEDULED }, [
      'p1',
      'p2',
    ]);
    const { deps, uploads } = depsFor(server, store);

    // First attempt: files are still being scanned.
    const first = await syncVisitDraft(draft, deps);
    expect(uploads()).toBe(2);
    expect(first.visitOutcome).toBe('created');
    expect(first.cleared).toBe(false);
    expect(first.draft.syncState).toBe('partial');
    expect(first.draft.photos.every((p) => p.state === 'uploaded' && p.retryable)).toBe(true);
    expect(first.message).toMatch(/waiting for the malware scan/);
    expect((await store.get(draft.offlineClientId))?.kind).toBe('visit');

    // Scan passes; the retry links both photos and replays the visit.
    server.scanAll('clean');
    server.calls.length = 0;
    const second = await syncVisitDraft(first.draft, deps);
    expect(uploads()).toBe(2);
    expect(server.calls.filter((c) => c.endsWith('/upload-intents'))).toHaveLength(0);
    expect(second.visitOutcome).toBe('replayed');
    expect(second.cleared).toBe(true);
    expect(server.visits.get(draft.offlineClientId)?.submits).toBe(2);
    expect(server.evidence.size).toBe(2);
    expect([...server.evidence.values()].map((e) => e.caption).sort()).toEqual([
      'caption p1',
      'caption p2',
    ]);
    expect(await store.get(draft.offlineClientId)).toBeNull();
    expect(await storage.getBlob(`user-a|${draft.offlineClientId}|p1`)).toBeUndefined();
  });

  it('field visit: the visit is created first, then photos are linked to it', async () => {
    const server = fakeServer();
    const { store, draft } = await draftWithPhotos({}, ['p1']);
    const { deps } = depsFor(server, store);
    server.scanAll('clean');
    // Files are marked clean as soon as they exist in this run.
    const origApi = deps.api;
    deps.api = async <T>(path: string, init?: { body?: unknown }) => {
      const r = await origApi<T>(path, init);
      server.scanAll('clean');
      return r;
    };
    const out = await syncVisitDraft(draft, deps);
    expect(out.visitOutcome).toBe('created');
    expect(out.cleared).toBe(true);
    const syncIdx = server.calls.indexOf('/api/v1/site-visits/sync');
    const linkIdx = server.calls.findIndex((c) => c.endsWith('/evidence'));
    expect(syncIdx).toBeGreaterThan(-1);
    expect(linkIdx).toBeGreaterThan(syncIdx);
    expect(server.evidence.size).toBe(1);
  });

  it('a lost response followed by a retry replays instead of duplicating', async () => {
    const server = fakeServer();
    const { store, draft } = await draftWithPhotos({ siteVisitId: SCHEDULED }, ['p1']);
    const { deps } = depsFor(server, store);
    const first = await syncVisitDraft(draft, deps); // uploads; link is quarantined
    server.scanAll('clean');
    // The server links the evidence and records the visit, but both responses are lost.
    server.loseResponseOf(`/api/v1/projects/${PROJECT}/evidence`);
    const second = await syncVisitDraft(first.draft, deps);
    expect(second.cleared).toBe(false);
    expect(second.draft.lastSyncError?.reason).toBe('Failed to fetch');
    server.loseResponseOf('/api/v1/site-visits/sync');
    const third = await syncVisitDraft(second.draft, deps);
    expect(third.cleared).toBe(false);
    const fourth = await syncVisitDraft(third.draft, deps);
    expect(fourth.cleared).toBe(true);
    expect(fourth.visitOutcome).toBe('replayed');
    expect(server.evidence.size).toBe(1);
    expect(server.visits.size).toBe(1);
  });

  it('a network failure while linking keeps the photo instead of rejecting it', async () => {
    const server = fakeServer();
    const { store, draft } = await draftWithPhotos({ siteVisitId: SCHEDULED }, ['p1']);
    const { deps } = depsFor(server, store);
    const first = await syncVisitDraft(draft, deps);
    server.scanAll('clean');
    server.failOnce((path) =>
      path.endsWith('/evidence') ? new TypeError('Failed to fetch') : null,
    );
    const second = await syncVisitDraft(first.draft, deps);
    expect(second.cleared).toBe(false);
    expect(second.draft.photos[0]).toMatchObject({ state: 'uploaded' });
    expect(second.draft.syncState).toBe('partial');
    expect((await store.get(draft.offlineClientId))?.kind).toBe('visit');
    const third = await syncVisitDraft(second.draft, deps);
    expect(third.cleared).toBe(true);
    expect(server.evidence.size).toBe(1);
  });

  it('a photo the server refuses keeps the draft with the reason until it is removed', async () => {
    const server = fakeServer();
    const { store, draft } = await draftWithPhotos({ siteVisitId: SCHEDULED }, ['p1']);
    const { deps } = depsFor(server, store);
    const first = await syncVisitDraft(draft, deps);
    server.scanAll('infected');
    const second = await syncVisitDraft(first.draft, deps);
    expect(second.cleared).toBe(false);
    expect(second.draft.photos[0]).toMatchObject({ state: 'rejected', retryable: false });
    expect(second.message).toMatch(/refused/);
    expect((await store.get(draft.offlineClientId))?.kind).toBe('visit');
    // The inspector removes the refused photo; the next sync replays and clears.
    const third = await syncVisitDraft({ ...second.draft, photos: [] }, deps);
    expect(third.cleared).toBe(true);
    expect(third.visitOutcome).toBe('replayed');
  });

  it('keeps the draft intact when the network fails before anything reaches the server', async () => {
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
    expect(outcome.visitOutcome).toBe('not_attempted');
    expect(outcome.draft.syncState).toBe('unsynced');
    expect(outcome.draft.lastSyncError?.reason).toBe('Failed to fetch');
    expect((await store.get(draft.offlineClientId))?.kind).toBe('visit');
  });

  it('refuses to start while offline', async () => {
    const { store, draft } = await draftWithPhotos({}, []);
    await expect(
      syncVisitDraft(draft, {
        api: async () => {
          throw new Error('should not be called');
        },
        uploadBytes: async () => undefined,
        store,
        isOnline: () => false,
      }),
    ).rejects.toBeInstanceOf(OfflineError);
  });
});

describe('syncReportDraft', () => {
  function reportDraft(over: Partial<ReportDraft> = {}): ReportDraft {
    return {
      kind: 'report',
      offlineClientId: 'report_abc12345',
      userId: 'user-a',
      projectId: PROJECT,
      reportId: null,
      title: 'Inspection report',
      reportKind: 'inspection',
      summary: 'Summary',
      bodyMarkdown: 'Body',
      scopeLimitations: '',
      siteVisitId: null,
      createdAt: at,
      updatedAt: at,
      syncState: 'unsynced',
      serverReportId: null,
      lastSyncAt: null,
      lastSyncError: null,
      ...over,
    };
  }

  it('does not post a duplicate revision when an earlier attempt already landed', async () => {
    const storage = createMemoryStorage();
    const store = createDraftStore({
      userId: 'user-a',
      key: await getSessionKey('user-a', memoryKeyStore()),
      storage,
    });
    const draft = reportDraft({ reportId: 'r1', offlineClientId: 'report_rev12345' });
    await store.put(draft);
    const posted: string[] = [];
    const out = await syncReportDraft(draft, {
      api: async <T>(path: string, init?: { body?: unknown }) => {
        if (init?.body) posted.push(path);
        return {
          id: 'r1',
          version: 3,
          currentVersion: 2,
          revisions: [
            {
              version: 2,
              createdBy: 'user-a',
              bodyMarkdown: 'Body',
              summary: 'Summary',
              scopeLimitations: null,
            },
          ],
        } as T;
      },
      uploadBytes: async () => undefined,
      store,
      isOnline: () => true,
    });
    expect(out.cleared).toBe(true);
    expect(posted).toEqual([]);
    expect(out.message).toMatch(/nothing was duplicated/);
  });

  it('marks network failures unsynced and API refusals rejected', async () => {
    const storage = createMemoryStorage();
    const store = createDraftStore({
      userId: 'user-a',
      key: await getSessionKey('user-a', memoryKeyStore()),
      storage,
    });
    const draft = reportDraft();
    await store.put(draft);
    const base = { uploadBytes: async () => undefined, store, isOnline: () => true };
    const net = await syncReportDraft(draft, {
      ...base,
      api: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect(net.draft.syncState).toBe('unsynced');
    const refused = await syncReportDraft(draft, {
      ...base,
      api: async () => {
        throw apiError(403, 'forbidden', 'not assigned');
      },
    });
    expect(refused.draft.syncState).toBe('rejected');
    expect((await store.get(draft.offlineClientId))?.kind).toBe('report');
  });
});
