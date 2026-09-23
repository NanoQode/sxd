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
 * 2. photos of an already scheduled visit: link as evidence with a per-photo
 *    offline id (idempotent; quarantined files stay retryable);
 * 3. `POST /api/v1/site-visits/sync` with the draft's offline id; `created`
 *    and `replayed` both count as confirmation, `rejected` keeps the draft
 *    with the server's reason;
 * 4. the draft leaves the device only once the visit is confirmed and every
 *    photo is either linked or definitively rejected.
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
  return typeof e?.code === 'string' ? e.code : 'unknown';
}

function messageOf(err: unknown): string {
  const e = err as CodedError;
  return typeof e?.message === 'string' && e.message ? e.message : 'request failed';
}

/** Rejections the server marks as retryable (scan still running) keep the photo. */
export function isRetryableEvidenceRejection(codeOrReason: string | null): boolean {
  if (!codeOrReason) return false;
  return /quarantin|scan|not passed|checksum yet|finalise/i.test(codeOrReason);
}

export function evidenceOfflineId(
  draft: Pick<VisitDraft, 'offlineClientId'>,
  photo: Pick<PhotoDraft, 'id'>,
): string {
  return `${draft.offlineClientId}.${photo.id}`.slice(0, 128);
}

export function buildSyncItem(draft: VisitDraft): SiteVisitSyncItem {
  const evidenceFileIds = draft.photos
    .filter((p) => p.fileId && p.state !== 'rejected')
    .map((p) => p.fileId as string);
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
    evidenceFileIds,
  };
  if (draft.siteVisitId) item.siteVisitId = draft.siteVisitId;
  else item.projectId = draft.projectId;
  return item;
}

/**
 * Pure: folds a server sync result into the draft. Both `created` and
 * `replayed` confirm the visit; per-file outcomes update photos so a later
 * retry only touches what is still outstanding.
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
      return {
        ...p,
        state: retryable ? 'uploaded' : 'rejected',
        retryable,
        reason: e.reason,
        evidenceId: p.evidenceId,
      };
    }
    return { ...p, state: 'linked', evidenceId: e.evidenceId, reason: null, retryable: false };
  });
  const outstanding = photos.some((p) => p.state !== 'linked' && p.state !== 'rejected');
  return {
    ...draft,
    photos,
    serverVisitId: result.siteVisitId,
    syncState: outstanding ? 'partial' : 'synced',
    lastSyncAt: at,
    lastSyncError: null,
  };
}

export function isDraftFullyConfirmed(draft: VisitDraft): boolean {
  return (
    draft.serverVisitId !== null &&
    draft.syncState === 'synced' &&
    draft.photos.every((p) => p.state === 'linked' || p.state === 'rejected')
  );
}

async function uploadPhoto(
  draft: VisitDraft,
  photo: PhotoDraft,
  deps: SyncDeps,
): Promise<PhotoDraft> {
  const bytes = await deps.store.getPhotoBytes(draft.offlineClientId, photo.id);
  if (!bytes) {
    return {
      ...photo,
      state: 'rejected',
      retryable: false,
      reason: 'photo bytes are missing on this device',
    };
  }
  const intent = await deps.api<UploadIntentResponse>('/api/v1/files/upload-intents', {
    body: {
      purpose: 'evidence',
      fileName: photo.name,
      declaredMime: photo.mime,
      sizeBytes: photo.sizeBytes,
      entityType: draft.siteVisitId ? 'site_visit' : 'project',
      entityId: draft.siteVisitId ?? draft.projectId,
    },
  });
  if (intent.upload.kind !== 'single') {
    return {
      ...photo,
      state: 'rejected',
      retryable: false,
      reason:
        'file too large for field sync; upload it from the evidence page on a stable connection',
    };
  }
  await deps.uploadBytes(intent.upload.url, intent.upload.headers, bytes.bytes, photo.mime);
  const finalized = await deps.api<FileFinalizeResponse>(
    `/api/v1/files/${intent.fileId}/finalize`,
    {
      body: {},
    },
  );
  if (finalized.outcome === 'rejected') {
    return {
      ...photo,
      fileId: intent.fileId,
      state: 'rejected',
      retryable: false,
      reason: finalized.file.statusReason ?? 'the file was rejected after inspection',
    };
  }
  return { ...photo, fileId: intent.fileId, state: 'uploaded', reason: null, retryable: true };
}

async function linkPhoto(
  draft: VisitDraft,
  photo: PhotoDraft,
  siteVisitId: string,
  deps: SyncDeps,
): Promise<PhotoDraft> {
  try {
    const ev = await deps.api<EvidenceDto & { idempotentReplay: boolean }>(
      `/api/v1/projects/${draft.projectId}/evidence`,
      {
        body: {
          fileId: photo.fileId,
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
          offlineClientId: evidenceOfflineId(draft, photo),
        },
      },
    );
    return { ...photo, state: 'linked', evidenceId: ev.id, reason: null, retryable: false };
  } catch (err) {
    const code = codeOf(err);
    if (code === 'file_quarantined') {
      return { ...photo, state: 'uploaded', retryable: true, reason: messageOf(err) };
    }
    return { ...photo, state: 'rejected', retryable: false, reason: `${code}: ${messageOf(err)}` };
  }
}

export async function syncVisitDraft(input: VisitDraft, deps: SyncDeps): Promise<VisitSyncOutcome> {
  const online =
    deps.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  if (!online()) throw new OfflineError();
  const now = deps.now ?? (() => new Date());
  let draft: VisitDraft = { ...input, syncState: 'syncing' };
  await deps.store.put(draft);

  const persistPhoto = async (photo: PhotoDraft) => {
    draft = { ...draft, photos: draft.photos.map((p) => (p.id === photo.id ? photo : p)) };
    await deps.store.put(draft);
  };

  try {
    // 1. Upload bytes that are not yet on the server.
    for (const photo of draft.photos) {
      if (photo.fileId || photo.state === 'rejected') continue;
      await persistPhoto(await uploadPhoto(draft, photo, deps));
    }
    // 2. Link evidence with GPS when the visit already exists server-side.
    const knownVisitId = draft.siteVisitId ?? draft.serverVisitId;
    if (knownVisitId) {
      for (const photo of draft.photos) {
        if (!photo.fileId || photo.state === 'linked' || photo.state === 'rejected') continue;
        await persistPhoto(await linkPhoto(draft, photo, knownVisitId, deps));
      }
    }
    // 3. Submit (or replay) the visit itself.
    const item = buildSyncItem(draft);
    const res = await deps.api<{ results: SiteVisitSyncResult[] }>('/api/v1/site-visits/sync', {
      body: { items: [item] },
    });
    const result = res.results.find((r) => r.offlineClientId === draft.offlineClientId);
    if (!result) throw new Error('the server did not report an outcome for this draft');
    draft = applySyncResult(draft, result, now().toISOString());
    // 4. Clear only after confirmation.
    if (isDraftFullyConfirmed(draft)) {
      await deps.store.delete(draft.offlineClientId);
      return {
        draft,
        cleared: true,
        visitOutcome: result.outcome,
        message:
          result.outcome === 'replayed'
            ? 'Already on the server: the earlier submission was found and nothing was duplicated.'
            : 'Visit submitted. The draft has been removed from this device.',
      };
    }
    await deps.store.put(draft);
    return {
      draft,
      cleared: false,
      visitOutcome: result.outcome,
      message:
        result.outcome === 'rejected'
          ? `The server rejected the visit (${result.code ?? 'rejected'}): ${result.reason ?? 'no reason given'}. The draft stays on this device.`
          : 'Visit confirmed; some photos are still waiting for the malware scan. Sync again later to finish.',
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
      visitOutcome: 'not_attempted',
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
    if (draft.reportId) {
      const current = await deps.api<ReportDetailDto>(`/api/v1/reports/${draft.reportId}`);
      const saved = await deps.api<ReportDto>(`/api/v1/reports/${draft.reportId}/revisions`, {
        body: { ...revision, expectedVersion: current.version },
      });
      reportId = saved.id;
    } else {
      const created = await deps.api<ReportDto>(`/api/v1/projects/${draft.projectId}/reports`, {
        body: {
          kind: draft.reportKind,
          title: draft.title,
          siteVisitId: draft.siteVisitId,
          offlineClientId: draft.offlineClientId,
          initialRevision: revision,
        },
      });
      reportId = created.id;
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
      message: 'Report draft saved on the server and removed from this device.',
    };
  } catch (err) {
    if (err instanceof OfflineError) throw err;
    draft = {
      ...draft,
      syncState: 'rejected',
      lastSyncAt: now().toISOString(),
      lastSyncError: { code: codeOf(err), reason: messageOf(err) },
    };
    await deps.store.put(draft);
    return {
      draft,
      cleared: false,
      reportId: null,
      message: `Could not save the report: ${messageOf(err)}. The draft stays on this device.`,
    };
  }
}
