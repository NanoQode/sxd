import 'server-only';
import { ApiError, SENSITIVE_FILE_PURPOSES, type FileDto, type FileGrantDto } from '@simplexd/contracts';
import type { schema } from '@simplexd/db';
import type { RequestIdentity } from '@/lib/auth/session';

/** Helpers shared by the file services. */

export type FileRow = typeof schema.fileObjects.$inferSelect;
export type FileGrantRow = typeof schema.fileAccessGrants.$inferSelect;

/**
 * Shape of `file_objects.scan_result`. Written by finalisation (inspection
 * outcome) and the scan worker (verdict); never contains object bytes.
 */
export interface FileScanRecord {
  verdict?: 'clean' | 'infected' | 'error' | 'rejected';
  signature?: string | null;
  engine?: string;
  durationMs?: number;
  error?: string;
  /** Human-readable reason for rejected / scan_failed outcomes. */
  reason?: string;
  /** Scan attempts made so far (scan_failed retries). */
  attempts?: number;
  /** True once the retry budget is exhausted and the object is left quarantined. */
  exhausted?: boolean;
  inspection?: { detectedMime: string | null; activeContent: string | null };
}

export interface ServiceOptions {
  correlationId?: string;
  ipHash?: string | null;
}

export function userIdOf(identity: RequestIdentity): string {
  const id = identity.session?.user.id;
  if (!id) throw new ApiError('unauthenticated', 'sign in required');
  return id;
}

export function ctxFor(identity: RequestIdentity, options?: ServiceOptions) {
  return { ...identity.ctx, correlationId: options?.correlationId ?? identity.ctx.correlationId };
}

export function isStaffIdentity(identity: RequestIdentity): boolean {
  return identity.actor.staffRoles.length > 0;
}

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function isSensitivePurpose(purpose: string): boolean {
  return (SENSITIVE_FILE_PURPOSES as readonly string[]).includes(purpose);
}

export function scanRecordOf(file: Pick<FileRow, 'scanResult'>): FileScanRecord {
  const value = file.scanResult;
  return value && typeof value === 'object' ? (value as FileScanRecord) : {};
}

export function statusReasonOf(file: Pick<FileRow, 'status' | 'scanResult'>): string | null {
  const scan = scanRecordOf(file);
  switch (file.status) {
    case 'rejected':
      return scan.reason ?? 'the file failed content inspection';
    case 'infected':
      return `malware detected${scan.signature ? ` (${scan.signature})` : ''}; the file stays quarantined`;
    case 'scan_failed':
      return scan.reason ?? scan.error ?? 'the malware scanner could not scan the file; it stays quarantined';
    default:
      return null;
  }
}

export function variantsOf(file: Pick<FileRow, 'derivatives'>): Array<'thumb' | 'web'> {
  const d = file.derivatives ?? {};
  const out: Array<'thumb' | 'web'> = [];
  if (typeof d['thumb'] === 'string') out.push('thumb');
  if (typeof d['web'] === 'string') out.push('web');
  return out;
}

/** Public DTO: storage keys, buckets and raw scanner output are never exposed. */
export function toFileDto(file: FileRow): FileDto {
  return {
    id: file.id,
    organizationId: file.organizationId,
    ownerUserId: file.ownerUserId,
    purpose: file.purpose,
    status: file.status,
    originalName: file.originalName,
    declaredMime: file.declaredMime,
    detectedMime: file.detectedMime,
    sizeBytes: file.sizeBytes,
    checksumSha256: file.checksumSha256,
    entityType: file.entityType,
    entityId: file.entityId,
    uploadKind: file.uploadKind,
    sensitive: isSensitivePurpose(file.purpose),
    isPublicApproved: file.isPublicApproved,
    variants: variantsOf(file),
    statusReason: statusReasonOf(file),
    scannedAt: iso(file.scannedAt),
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
  };
}

export function toGrantDto(grant: FileGrantRow): FileGrantDto {
  return {
    id: grant.id,
    fileId: grant.fileId,
    userId: grant.userId,
    organizationId: grant.organizationId,
    level: grant.level,
    grantedBy: grant.grantedBy,
    expiresAt: iso(grant.expiresAt),
    revokedAt: iso(grant.revokedAt),
    createdAt: grant.createdAt.toISOString(),
  };
}

export function notFound(what = 'file'): ApiError {
  return new ApiError('not_found', `${what} not found`);
}

/** Maps a non-clean status to the stable error the brief requires. */
export function unavailableError(file: Pick<FileRow, 'id' | 'status' | 'scanResult'>): ApiError {
  const details = { fileId: file.id, status: file.status };
  switch (file.status) {
    case 'pending_upload':
    case 'uploaded':
    case 'scanning':
      return new ApiError('file_quarantined', 'the file has not passed malware scanning yet', {
        details,
        retryable: true,
      });
    case 'scan_failed':
      return new ApiError(
        'file_quarantined',
        'the malware scanner could not scan this file; it remains quarantined',
        { details, retryable: true },
      );
    case 'infected':
      return new ApiError('file_rejected', 'the file failed malware scanning and is not available', {
        details,
      });
    case 'rejected':
      return new ApiError('file_rejected', statusReasonOf(file) ?? 'the file was rejected', {
        details,
      });
    case 'deleted':
      return notFound();
    default:
      return new ApiError('file_quarantined', 'the file is not available', { details });
  }
}
