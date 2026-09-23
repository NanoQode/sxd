/**
 * Offline field-capture records. Everything here lives in the browser
 * (IndexedDB) until the server confirms it; see `store.ts` for the storage
 * and encryption rules and `sync.ts` for the upload/replay protocol.
 */

export interface ChecklistItem {
  key: string;
  label: string;
  checked: boolean;
  note?: string;
}

/** Device-reported position. User-provided and labelled as such; never proof of presence. */
export interface CaptureGps {
  lat: number;
  lon: number;
  accuracyM: number | null;
  capturedAt: string;
  source: 'device_user_provided';
}

export type PhotoUploadState = 'pending' | 'uploaded' | 'linked' | 'rejected';

export interface PhotoDraft {
  /** Stable id inside the draft; also the suffix of the evidence offline id. */
  id: string;
  name: string;
  mime: string;
  sizeBytes: number;
  capturedAt: string;
  caption: string;
  /** Set once the file object exists on the server (intent + PUT + finalize done). */
  fileId: string | null;
  /** Set once the evidence row exists (link confirmed by the server). */
  evidenceId: string | null;
  state: PhotoUploadState;
  reason: string | null;
  /** True when the last failure was a scan-pending quarantine: retry later. */
  retryable: boolean;
}

export type DraftSyncState = 'unsynced' | 'syncing' | 'partial' | 'synced' | 'rejected';

export interface VisitDraft {
  kind: 'visit';
  offlineClientId: string;
  /** Owner: drafts are namespaced per signed-in user. */
  userId: string;
  projectId: string;
  /** Existing scheduled visit; null when the visit was created in the field. */
  siteVisitId: string | null;
  title: string;
  findingsMarkdown: string;
  checklist: ChecklistItem[];
  weather: string;
  accessNote: string;
  gps: CaptureGps | null;
  photos: PhotoDraft[];
  startedAt: string;
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
  syncState: DraftSyncState;
  /** Visit id confirmed by the server (created or replayed). */
  serverVisitId: string | null;
  lastSyncAt: string | null;
  lastSyncError: { code: string; reason: string } | null;
}

export interface ReportDraft {
  kind: 'report';
  offlineClientId: string;
  userId: string;
  projectId: string;
  /** Existing report being revised; null for a new report. */
  reportId: string | null;
  title: string;
  reportKind: string;
  summary: string;
  bodyMarkdown: string;
  scopeLimitations: string;
  siteVisitId: string | null;
  createdAt: string;
  updatedAt: string;
  syncState: DraftSyncState;
  serverReportId: string | null;
  lastSyncAt: string | null;
  lastSyncError: { code: string; reason: string } | null;
}

export type Draft = VisitDraft | ReportDraft;

/** Fields kept in clear text so lists render without decrypting the body. */
export const VISIT_PUBLIC_FIELDS = [
  'kind',
  'offlineClientId',
  'userId',
  'projectId',
  'siteVisitId',
  'title',
  'startedAt',
  'submittedAt',
  'createdAt',
  'updatedAt',
  'syncState',
  'serverVisitId',
  'lastSyncAt',
  'lastSyncError',
] as const satisfies readonly (keyof VisitDraft)[];

export const REPORT_PUBLIC_FIELDS = [
  'kind',
  'offlineClientId',
  'userId',
  'projectId',
  'reportId',
  'title',
  'reportKind',
  'siteVisitId',
  'createdAt',
  'updatedAt',
  'syncState',
  'serverReportId',
  'lastSyncAt',
  'lastSyncError',
] as const satisfies readonly (keyof ReportDraft)[];

/** Summary of a draft that could not be decrypted (key from another browser session). */
export interface LockedDraft {
  kind: 'locked';
  offlineClientId: string;
  userId: string;
  draftKind: 'visit' | 'report';
  title: string;
  updatedAt: string;
  syncState: DraftSyncState;
}

export function newOfflineClientId(prefix: 'visit' | 'report' | 'evidence'): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}_${rand}`;
}
