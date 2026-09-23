/**
 * Upload and evidence policy: allow-listed types, blocked executable content,
 * size limits and badge semantics. EXIF/GPS is user-provided evidence, not
 * proof of authenticity; server receipt time is recorded separately.
 */

export const ALLOWED_UPLOAD_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'video/mp4',
  'video/quicktime',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'application/json',
  'application/zip',
  'application/dxf',
  'image/vnd.dwg',
] as const;

export const BLOCKED_UPLOAD_MIME = [
  'image/svg+xml',
  'text/html',
  'application/xhtml+xml',
  'text/javascript',
  'application/javascript',
  'application/x-sh',
  'application/x-msdownload',
  'application/x-httpd-php',
] as const;

export const BLOCKED_EXTENSIONS = [
  '.svg',
  '.html',
  '.htm',
  '.js',
  '.mjs',
  '.cjs',
  '.sh',
  '.exe',
  '.bat',
  '.cmd',
  '.php',
  '.jar',
  '.msi',
  '.scr',
  '.ps1',
  '.vbs',
] as const;

export interface UploadRequest {
  fileName: string;
  declaredMime: string;
  sizeBytes: number;
  purpose: string;
}

export interface UploadPolicy {
  maxBytes: number;
  allowedMime?: readonly string[];
}

export type UploadDecision = { ok: true; kind: EvidenceKind } | { ok: false; reason: string };

export type EvidenceKind = 'photo' | 'video' | 'drone' | 'document' | 'audio' | 'drawing' | 'other';

export function extensionOf(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx === -1 ? '' : name.slice(idx).toLowerCase();
}

export function kindForMime(mime: string, fileName: string): EvidenceKind {
  if (mime.startsWith('image/')) return 'photo';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (
    mime === 'application/dxf' ||
    mime === 'image/vnd.dwg' ||
    ['.dxf', '.dwg'].includes(extensionOf(fileName))
  )
    return 'drawing';
  if (
    mime === 'application/pdf' ||
    mime.includes('officedocument') ||
    mime === 'text/csv' ||
    mime === 'application/json'
  )
    return 'document';
  return 'other';
}

export function evaluateUpload(req: UploadRequest, policy: UploadPolicy): UploadDecision {
  const mime = req.declaredMime.toLowerCase().split(';')[0]!.trim();
  const ext = extensionOf(req.fileName);
  if ((BLOCKED_EXTENSIONS as readonly string[]).includes(ext))
    return { ok: false, reason: `files with the ${ext} extension are not accepted` };
  if ((BLOCKED_UPLOAD_MIME as readonly string[]).includes(mime))
    return { ok: false, reason: `${mime} content is not accepted` };
  const allowed = policy.allowedMime ?? ALLOWED_UPLOAD_MIME;
  if (!allowed.includes(mime)) return { ok: false, reason: `${mime} is not an accepted file type` };
  if (!Number.isFinite(req.sizeBytes) || req.sizeBytes <= 0)
    return { ok: false, reason: 'file size must be positive' };
  if (req.sizeBytes > policy.maxBytes)
    return {
      ok: false,
      reason: `file exceeds the ${Math.round(policy.maxBytes / 1_048_576)} MB limit`,
    };
  if (req.fileName.length > 255 || /[\u0000-\u001f\\/]/.test(req.fileName))
    return { ok: false, reason: 'invalid file name' };
  return { ok: true, kind: kindForMime(mime, req.fileName) };
}

/** Whether the detected content type contradicts the declared one in a way that matters. */
export function mimeMismatch(declared: string, detected: string | null): boolean {
  if (!detected) return false;
  const d = declared.toLowerCase();
  const t = detected.toLowerCase();
  if (d === t) return false;
  // Treat family matches (image/jpeg vs image/jpg, heic/heif) as fine.
  const family = (m: string) => m.split('/')[0];
  if (family(d) === family(t) && d.includes('jp') && t.includes('jp')) return false;
  if ((d.includes('heic') || d.includes('heif')) && (t.includes('heic') || t.includes('heif')))
    return false;
  // Office documents and zips share a container.
  if (t === 'application/zip' && d.includes('officedocument')) return false;
  return true;
}

export type EvidenceBadge =
  | 'sourced_observation'
  | 'verified_operational_record'
  | 'regional_context'
  | 'model_estimate'
  | 'user_assumption'
  | 'unknown'
  | 'stale'
  | 'disputed';

export const EVIDENCE_BADGE_LABELS: Record<EvidenceBadge, { label: string; description: string }> =
  {
    sourced_observation: {
      label: 'Sourced observation',
      description: 'Read from a named published source with retrieval and observation dates.',
    },
    verified_operational_record: {
      label: 'Verified operational record',
      description: 'First-party record verified by SimplexD staff.',
    },
    regional_context: {
      label: 'Regional context',
      description: 'A statewide or regional figure; not a city value.',
    },
    model_estimate: {
      label: 'Model estimate',
      description: 'Computed from assumptions and policy bounds.',
    },
    user_assumption: { label: 'Your assumption', description: 'Entered by you for a scenario.' },
    unknown: { label: 'Unknown', description: 'No evidence collected yet.' },
    stale: {
      label: 'Stale',
      description: 'Older than the freshness policy; excluded from default ranking.',
    },
    disputed: { label: 'Disputed', description: 'Under review after a challenge.' },
  };

export interface FreshnessInput {
  observedAt: string | null;
  validUntil?: string | null;
  maxAgeDays: number | null;
  respectSourceValidity: boolean;
}

/** Freshness is computed from observation/publication dates and policy, never from import time. */
export function isFresh(input: FreshnessInput, asOf: Date): boolean {
  if (input.respectSourceValidity && input.validUntil) {
    return new Date(input.validUntil).getTime() >= asOf.getTime();
  }
  if (input.maxAgeDays === null) return true;
  if (!input.observedAt) return false;
  const ageDays = (asOf.getTime() - new Date(input.observedAt).getTime()) / 86_400_000;
  return ageDays <= input.maxAgeDays;
}
