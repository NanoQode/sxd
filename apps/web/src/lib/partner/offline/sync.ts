import type {
  EvidenceDto,
  FileFinalizeResponse,
  ReportDetailDto,
  ReportDto,
  SiteVisitSyncItem,
  SiteVisitSyncResult,
  UploadIntentResponse,
} from '@simplexd/contracts';
import type { DraftStore } from './store';
import type { PhotoDraft, ReportDraft, VisitDraft } from './types';

/**
 * Upload-and-replay protocol for offline drafts.
 *
 * Order of operations for a visit draft, each step persisted before the next
 * so a retry never repeats work the server already confirmed:
 * 1. photos without a `fileId`: upload intent → PUT bytes → finalize;
 * 2. when the visit already exists on the server (scheduled visit, or an
 *    earlier sync created it): link each uploaded photo as evidence with its
 *    caption, capture time and user-provided GPS;
 * 3. `POST /api/v1/site-visits/sync` with the draft's offline id. `created`
 *    and `replayed` both confirm the visit; `rejected` keeps the draft with
 *    the server's reason;
 * 4. photos of a visit created in the field are linked now that its id is
 *    known;
 * 5. the draft leaves the device only when the visit is confirmed and every
 *    photo is linked. A photo the server rejected keeps the draft (with the
 *    reason) until the inspector removes it, so nothing disappears silently.
 *
 * Idempotency: the visit replays on its offline id, and each evidence link
 * uses `${offlineClientId}:${fileId}` — the same key the server's own sync
 * uses when it links files — so a lost response followed by a retry, from
 * either path, never creates a second evidence row.
 *
 * Failures are classified: definitive API refusals (4xx) mark the photo or
 * visit rejected; network errors, 401, 408, 429 and 5xx abort the attempt and
 * leave everything on the device for the next try.
 */

export interface SyncApi {
  <T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
}

export interface SyncDeps {
  api: SyncApi;
  /** Raw PUT to the signed storage URL; resolves when the object is stored. */
  uploadBytes(
    url: string,
    headers: Record<string, string>,
    bytes: ArrayBuffer,
    mime: string,
  ): Promise<void>;
  store: DraftStore;
  now?: () => Date;
  isOnline?: () => boolean;
}

export interface VisitSyncOutcome {
  draft: VisitDraft;
  /** Removed from the device because the server confirmed everything. */
  cleared: boolean;
  visitOutcome: 'created' | 'replayed' | 'rejected' | 'not_attempted';
  message: string;
}

export class OfflineError extends Error {
  constructor() {
    super('You are offline. Drafts stay on this device until you sync.');
    this.name = 'OfflineError';
  }
}

interface CodedError {
  code?: string;
  message?: string;
  status?: number;
}

function codeOf(err: unknown): string {
  const e = err as CodedError;
  return typeof e?.code === 'string' ? e.code : 'network';
}

function messageOf(err: unknown): string {
  const e = err as CodedError;
  return typeof e?.message === 'string' && e.message ? e.message : 'request failed';
}

export type FailureKind = 'transient' | 'quarantined' | 'definitive';

/**
 * `quarantined`: the file exists but has not passed the malware scan yet.
 * `definitive`: the API refused the request for a reason a retry will not fix.
 * `transient`: anything else (no HTTP status, session expired, rate limited,
 * server error): keep everything and try again later.
 */
export function classifyFailure(err: unknown): FailureKind {
  const e = err as CodedError;
  if (e?.code === 'file_quarantined') return 'quarantined';
  const status = typeof e?.status === 'number' ? e.status : null;
  if (status === null) return 'transient';
  if (status === 401 || status === 408 || status === 429 || status >= 500) return 'transient';
  return status >= 400 ? 'definitive' : 'transient';
}

/** Rejections the server marks as retryable (scan still running) keep the photo. */
export function isRetryableEvidenceRejection(codeOrReason: string | null): boolean {
  if (!codeOrReason) return false;
  return /quarantin|scan|not passed|checksum yet|finalise/i.test(codeOrReason);
}

/** Same derivation as the server's site-visit sync (`${offlineClientId}:${fileId}`). */
export function evidenceOfflineId(offlineClientId: string, fileId: string): string {
  return `${offlineClientId}:${fileId}`.slice(0, 128);
}

/**
 * The visit payload. Photos are linked individually (steps 2 and 4) so their
 * caption, capture time and GPS travel with them; the server's bulk link would
 * drop that metadata, so `evidenceFileIds` is always empty here.
 */
export function buildSyncItem(draft: VisitDraft): SiteVisitSyncItem {
  const item: SiteVisitSyncItem = {
    offlineClientId: draft.offlineClientId,
    startedAt: draft.startedAt,
    submittedAt: draft.submittedAt ?? draft.updatedAt,
    findingsMarkdown: draft.findingsMarkdown,
    checklist: {
      items: draft.checklist,
      capture: draft.gps
        ? {
            gps: {
              lat: draft.gps.lat,
              lon: draft.gps.lon,
              accuracyM: draft.gps.accuracyM,
              capturedAt: draft.gps.capturedAt,
              source: draft.gps.source,
              note: 'User-provided device position; not proof of presence.',
            },
          }
        : null,
    },
    weather: draft.weather.trim() ? draft.weather.trim() : null,
    accessNote: draft.accessNote.trim() ? draft.accessNote.trim() : null,
    evidenceFileIds: [],
  };
  if (draft.siteVisitId) item.siteVisitId = draft.siteVisitId;
  else item.projectId = draft.projectId;
  return item;
}

/** Recomputes the sync state once the visit is confirmed. */
function settle(draft: VisitDraft): VisitDraft {
  if (draft.syncState === 'rejected' || !draft.serverVisitId) return draft;
  return {
    ...draft,
    syncState: draft.photos.every((p) => p.state === 'linked') ? 'synced' : 'partial',
  };
}

/**
 * Pure: folds a server sync result into the draft. Both `created` and
 * `replayed` confirm the visit; per-file outcomes (present when files were
 * sent in the item) update photos so a later retry only touches what is
 * still outstanding.
 */
export function applySyncResult(
  draft: VisitDraft,
  result: SiteVisitSyncResult,
  at: string,
): VisitDraft {
  if (result.outcome === 'rejected') {
    return {
      ...draft,
      syncState: 'rejected',
      lastSyncAt: at,
      lastSyncError: {
        code: result.code ?? 'rejected',
        reason: result.reason ?? 'rejected by server',
      },
    };
  }
  const byFile = new Map(result.evidence.map((e) => [e.fileId, e]));
  const photos = draft.photos.map((p): PhotoDraft => {
    if (!p.fileId) return p;
    const e = byFile.get(p.fileId);
    if (!e) return p;
    if (e.outcome === 'rejected') {
      const retryable = isRetryableEvidenceRejection(e.reason);
      return { ...p, state: retryable ? 'uploaded' : 'rejected', retryable, reason: e.reason };
    }
    return { ...p, state: 'linked', evidenceId: e.evidenceId, reason: null, retryable: false };
  });
  return settle({
    ...draft,
    photos,
    serverVisitId: result.siteVisitId,
    syncState: 'partial',
    lastSyncAt: at,
    lastSyncError: null,
  });
}

/** True only when the visit is confirmed and every photo is linked as evidence. */
export function isDraftFullyConfirmed(draft: VisitDraft): boolean {
  return (
    draft.serverVisitId !== null &&
    draft.syncState === 'synced' &&
    draft.photos.every((p) => p.state === 'linked')
  );
}

function rejectedPhoto(photo: PhotoDraft, reason: string, fileId?: string): PhotoDraft {
  return {
    ...photo,
    fileId: fileId ?? photo.fileId,
    state: 'rejected',
    retryable: false,
    reason,
  };
}

/** Calls the API; definitive refusals resolve to `null` + reason, transient ones throw. */
async function attempt<T>(
  call: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  try {
    return { ok: true, value: await call() };
  } catch (err) {
    if (classifyFailure(err) === 'definitive') {
      return { ok: false, reason: `${codeOf(err)}: ${messageOf(err)}` };
    }
    throw err;
  }
}

async function uploadPhoto(
  draft: VisitDraft,
  photo: PhotoDraft,
  deps: SyncDeps,
): Promise<PhotoDraft> {
  const bytes = await deps.store.getPhotoBytes(draft.offlineClientId, photo.id);
  if (!bytes) return rejectedPhoto(photo, 'photo bytes are missing on this device');
  const intent = await attempt(() =>
    deps.api<UploadIntentResponse>('/api/v1/files/upload-intents', {
      body: {
        purpose: 'evidence',
        fileName: photo.name,
        declaredMime: photo.mime,
        sizeBytes: photo.sizeBytes,
        entityType: draft.siteVisitId ? 'site_visit' : 'project',
        entityId: draft.siteVisitId ?? draft.projectId,
      },
    }),
  );
  if (!intent.ok) return rejectedPhoto(photo, intent.reason);
  const { fileId, upload } = intent.value;
  if (upload.kind !== 'single') {
    return rejectedPhoto(
      photo,
      'file too large for field sync; upload it from the evidence page on a stable connection',
    );
  }
  await deps.uploadBytes(upload.url, upload.headers, bytes.bytes, photo.mime);
  const finalized = await attempt(() =>
    deps.api<FileFinalizeResponse>(`/api/v1/files/${fileId}/finalize`, { body: {} }),
  );
  if (!finalized.ok) return rejectedPhoto(photo, finalized.reason, fileId);
  if (finalized.value.outcome === 'rejected') {
    return rejectedPhoto(
      photo,
      finalized.value.file.statusReason ?? 'the file was rejected after inspection',
      fileId,
    );
  }
  return { ...photo, fileId, state: 'uploaded', reason: null, retryable: true };
}

async function linkPhoto(
  draft: VisitDraft,
  photo: PhotoDraft,
  siteVisitId: string,
  deps: SyncDeps,
): Promise<PhotoDraft> {
  const fileId = photo.fileId as string;
  try {
    const ev = await deps.api<EvidenceDto & { idempotentReplay: boolean }>(
      `/api/v1/projects/${draft.projectId}/evidence`,
      {
        body: {
          fileId,
          kind: 'photo',
          caption: photo.caption.trim() ? photo.caption.trim() : null,
          capturedAt: photo.capturedAt,
          captureGps: draft.gps ? { lat: draft.gps.lat, lon: draft.gps.lon } : null,
          captureMetadata: draft.gps
            ? {
                gpsAccuracyM: draft.gps.accuracyM,
                gpsSource: draft.gps.source,
                gpsNote: 'User-provided device position; not proof of presence.',
              }
            : null,
          siteVisitId,
          offlineClientId: evidenceOfflineId(draft.offlineClientId, fileId),
        },
      },
    );
    return { ...photo, state: 'linked', evidenceId: ev.id, reason: null, retryable: false };
  } catch (err) {
    const kind = classifyFailure(err);
    if (kind === 'quarantined') {
      return { ...photo, state: 'uploaded', retryable: true, reason: messageOf(err) };
    }
    if (kind === 'definitive') return rejectedPhoto(photo, `${codeOf(err)}: ${messageOf(err)}`);
    throw err;
  }
}

function describeOutstanding(draft: VisitDraft): string {
  const waiting = draft.photos.filter((p) => p.state === 'uploaded' || p.state === 'pending');
  const rejected = draft.photos.filter((p) => p.state === 'rejected');
  const parts: string[] = [];
  if (waiting.length > 0) {
    parts.push(
      `${waiting.length} photo${waiting.length === 1 ? ' is' : 's are'} still waiting for the malware scan; sync again later`,
    );
  }
  if (rejected.length > 0) {
    parts.push(
      `${rejected.length} photo${rejected.length === 1 ? ' was' : 's were'} refused (${rejected
        .map((p) => p.reason ?? 'no reason given')
        .join(
          '; ',
        )}); remove ${rejected.length === 1 ? 'it' : 'them'} and sync again to clear the draft`,
    );
  }
  return parts.join('. ');
}

export async function syncVisitDraft(input: VisitDraft, deps: SyncDeps): Promise<VisitSyncOutcome> {
  const online =
    deps.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  if (!online()) throw new OfflineError();
  const now = deps.now ?? (() => new Date());
  let draft: VisitDraft = {
    ...input,
    submittedAt: input.submittedAt ?? now().toISOString(),
    syncState: 'syncing',
  };
  await deps.store.put(draft);

  const persistPhoto = async (photo: PhotoDraft) => {
    draft = { ...draft, photos: draft.photos.map((p) => (p.id === photo.id ? photo : p)) };
    await deps.store.put(draft);
  };
  const linkOutstanding = async (siteVisitId: string) => {
    for (const photo of draft.photos) {
      if (!photo.fileId || photo.state === 'linked' || photo.state === 'rejected') continue;
      await persistPhoto(await linkPhoto(draft, photo, siteVisitId, deps));
    }
  };

  let visitOutcome: VisitSyncOutcome['visitOutcome'] = 'not_attempted';
  try {
    // 1. Upload bytes that are not yet on the server.
    for (const photo of draft.photos) {
      if (photo.fileId || photo.state === 'rejected') continue;
      await persistPhoto(await uploadPhoto(draft, photo, deps));
    }
    // 2. Link evidence when the visit already exists server-side.
    const knownVisitId = draft.siteVisitId ?? draft.serverVisitId;
    if (knownVisitId) await linkOutstanding(knownVisitId);
    // 3. Submit (or replay) the visit itself.
    const res = await deps.api<{ results: SiteVisitSyncResult[] }>('/api/v1/site-visits/sync', {
      body: { items: [buildSyncItem(draft)] },
    });
    const result = res.results.find((r) => r.offlineClientId === draft.offlineClientId);
    if (!result) throw new Error('the server did not report an outcome for this draft');
    visitOutcome = result.outcome;
    draft = applySyncResult(draft, result, now().toISOString());
    await deps.store.put(draft);
    if (result.outcome === 'rejected') {
      return {
        draft,
        cleared: false,
        visitOutcome,
        message: `The server rejected the visit (${result.code ?? 'rejected'}): ${result.reason ?? 'no reason given'}. The draft stays on this device.`,
      };
    }
    // 4. Photos of a visit created in the field are linked once its id is known.
    if (result.siteVisitId) await linkOutstanding(result.siteVisitId);
    draft = settle(draft);
    // 5. Clear only after full confirmation.
    if (isDraftFullyConfirmed(draft)) {
      await deps.store.delete(draft.offlineClientId);
      return {
        draft,
        cleared: true,
        visitOutcome,
        message:
          result.outcome === 'replayed'
            ? 'Already on the server: the earlier submission was found and nothing was duplicated. The draft has been removed from this device.'
            : 'Visit submitted. The draft has been removed from this device.',
      };
    }
    await deps.store.put(draft);
    return {
      draft,
      cleared: false,
      visitOutcome,
      message: `Visit confirmed on the server. ${describeOutstanding(draft)}.`,
    };
  } catch (err) {
    if (err instanceof OfflineError) throw err;
    draft = {
      ...draft,
      syncState: draft.serverVisitId ? 'partial' : 'unsynced',
      lastSyncAt: now().toISOString(),
      lastSyncError: { code: codeOf(err), reason: messageOf(err) },
    };
    await deps.store.put(draft);
    return {
      draft,
      cleared: false,
      visitOutcome,
      message: `Sync did not complete: ${messageOf(err)}. Nothing was lost; try again when connected.`,
    };
  }
}

export interface ReportSyncOutcome {
  draft: ReportDraft;
  cleared: boolean;
  reportId: string | null;
  message: string;
}

function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? '').trim() === (b ?? '').trim();
}

export async function syncReportDraft(
  input: ReportDraft,
  deps: SyncDeps,
): Promise<ReportSyncOutcome> {
  const online =
    deps.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  if (!online()) throw new OfflineError();
  const now = deps.now ?? (() => new Date());
  let draft: ReportDraft = { ...input, syncState: 'syncing' };
  await deps.store.put(draft);
  const revision = {
    summary: draft.summary.trim() ? draft.summary.trim() : null,
    bodyMarkdown: draft.bodyMarkdown,
    scopeLimitations: draft.scopeLimitations.trim() ? draft.scopeLimitations.trim() : null,
    attachmentFileIds: [],
  };
  try {
    let reportId: string;
    let replayed = false;
    if (draft.reportId) {
      const current = await deps.api<ReportDetailDto>(`/api/v1/reports/${draft.reportId}`);
      const latest = current.revisions.find((r) => r.version === current.currentVersion);
      // A revision identical to the latest one means an earlier attempt already landed
      // (its response was lost); posting again would only add a duplicate revision.
      if (
        latest &&
        latest.createdBy === draft.userId &&
        sameText(latest.bodyMarkdown, revision.bodyMarkdown) &&
        sameText(latest.summary, revision.summary) &&
        sameText(latest.scopeLimitations, revision.scopeLimitations)
      ) {
        reportId = current.id;
        replayed = true;
      } else {
        const saved = await deps.api<ReportDto>(`/api/v1/reports/${draft.reportId}/revisions`, {
          body: { ...revision, expectedVersion: current.version },
        });
        reportId = saved.id;
      }
    } else {
      // Creation replays on the offline id, so a retry never creates a second report.
      const created = await deps.api<ReportDto & { idempotentReplay?: boolean }>(
        `/api/v1/projects/${draft.projectId}/reports`,
        {
          body: {
            kind: draft.reportKind,
            title: draft.title,
            siteVisitId: draft.siteVisitId,
            offlineClientId: draft.offlineClientId,
            initialRevision: revision,
          },
        },
      );
      reportId = created.id;
      replayed = created.idempotentReplay === true;
    }
    await deps.store.delete(draft.offlineClientId);
    draft = {
      ...draft,
      syncState: 'synced',
      serverReportId: reportId,
      lastSyncAt: now().toISOString(),
      lastSyncError: null,
    };
    return {
      draft,
      cleared: true,
      reportId,
      message: replayed
        ? 'Already on the server: nothing was duplicated. The draft has been removed from this device.'
        : 'Report draft saved on the server and removed from this device.',
    };
  } catch (err) {
    if (err instanceof OfflineError) throw err;
    const definitive = classifyFailure(err) === 'definitive';
    draft = {
      ...draft,
      syncState: definitive ? 'rejected' : 'unsynced',
      lastSyncAt: now().toISOString(),
      lastSyncError: { code: codeOf(err), reason: messageOf(err) },
    };
    await deps.store.put(draft);
    return {
      draft,
      cleared: false,
      reportId: null,
      message: definitive
        ? `The server refused the report: ${messageOf(err)}. The draft stays on this device.`
        : `Could not reach the server: ${messageOf(err)}. The draft stays on this device; try again when connected.`,
    };
  }
}
