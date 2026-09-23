import 'server-only';
import type { Readable } from 'node:stream';
import { and, eq } from 'drizzle-orm';
import { ApiError, type FileFinalize, type FileFinalizeResponse } from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor } from '@simplexd/db';
import {
  StorageError,
  inspectUploadedBytes,
  sha256Hex,
  verifyDeclaredChecksum,
  type ObjectLocation,
} from '@simplexd/integrations/storage';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { logger } from '@/lib/logger';
import {
  ctxFor,
  notFound,
  toFileDto,
  userIdOf,
  type FileRow,
  type FileScanRecord,
  type ServiceOptions,
} from './shared';
import { getStorage } from './storage';

/**
 * Finalisation: the owner tells the server the bytes are in quarantine. The
 * server verifies size and checksum, sniffs the first bytes (declared type vs
 * content, markup/script detection) and either rejects the file or moves it
 * to `scanning` and hands it to the worker through the outbox
 * (`file.uploaded` → `media.scan_and_process`).
 */

const SNIFF_BYTES = 64 * 1024;

async function readHead(stream: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
    chunks.push(buf.subarray(0, max - size));
    size += buf.length;
    if (size >= max) break;
  }
  stream.destroy();
  return Buffer.concat(chunks);
}

interface InspectionOutcome {
  reject: boolean;
  reason: string | null;
  sizeBytes: number;
  sha256: string;
  detectedMime: string | null;
  activeContent: string | null;
}

async function inspectObject(
  location: ObjectLocation,
  file: FileRow,
  declaredSha256: string | null,
): Promise<InspectionOutcome> {
  const storage = getStorage();
  const head = await storage.headObject(location);
  if (!head) {
    throw new ApiError(
      'conflict',
      'the upload has not reached storage yet; upload the bytes first, then finalise',
      {
        retryable: true,
        details: { fileId: file.id },
      },
    );
  }
  const base = { sizeBytes: head.sizeBytes, sha256: '', detectedMime: null, activeContent: null };
  if (file.sizeBytes !== null && head.sizeBytes !== file.sizeBytes) {
    return {
      ...base,
      reject: true,
      reason: `uploaded size ${head.sizeBytes} does not match the declared size ${file.sizeBytes}`,
    };
  }
  const sha256 = await sha256Hex(await storage.getObjectStream(location));
  if (declaredSha256) {
    const check = verifyDeclaredChecksum(declaredSha256, sha256);
    if (!check.ok) {
      return {
        ...base,
        sha256,
        reject: true,
        reason:
          check.reason === 'mismatch'
            ? 'the uploaded content does not match the declared SHA-256 checksum'
            : 'the declared SHA-256 checksum is malformed',
      };
    }
  }
  const bytes = await readHead(await storage.getObjectStream(location), SNIFF_BYTES);
  const inspection = await inspectUploadedBytes(bytes, file.declaredMime);
  return {
    sizeBytes: head.sizeBytes,
    sha256,
    detectedMime: inspection.detected?.mime ?? null,
    activeContent: inspection.active.kind,
    reject: inspection.reject,
    reason: inspection.reason,
  };
}

export async function finalizeUpload(
  identity: RequestIdentity,
  fileId: string,
  input: FileFinalize,
  options: ServiceOptions = {},
): Promise<FileFinalizeResponse> {
  const userId = userIdOf(identity);
  // Runs under the owner's own context: the file_objects policies let the owner
  // read and update the row, and the explicit owner check below is the application rule.
  const ctx = ctxFor(identity, options);
  const db = getDb();
  const storage = getStorage();

  const file = await withActor(db, ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.fileObjects)
      .where(eq(schema.fileObjects.id, fileId));
    return row ?? null;
  });
  if (!file || file.deletedAt) throw notFound();
  if (file.ownerUserId !== userId)
    throw new ApiError('forbidden', 'only the uploader can finalise an upload');
  if (file.status === 'scanning') return { file: toFileDto(file), outcome: 'scanning' };
  if (file.status !== 'pending_upload' && file.status !== 'uploaded') {
    throw new ApiError('invalid_transition', `the file is ${file.status} and cannot be finalised`, {
      details: { fileId, status: file.status },
    });
  }
  const location: ObjectLocation = { bucket: 'quarantine', key: file.storageKey };

  if (file.uploadKind === 'multipart') {
    if (!input.parts?.length) {
      throw new ApiError(
        'validation_failed',
        'multipart uploads must be finalised with the uploaded part ETags',
        {
          details: [{ path: 'parts', message: 'required' }],
        },
      );
    }
    if (!file.multipartUploadId)
      throw new ApiError('conflict', 'the multipart upload was not initialised');
    try {
      await storage.completeMultipart({
        ...location,
        uploadId: file.multipartUploadId,
        parts: input.parts,
      });
    } catch (err) {
      if (
        err instanceof StorageError &&
        (err.code === 'invalid_request' || err.code === 'not_found')
      ) {
        throw new ApiError('validation_failed', err.message, { details: { fileId } });
      }
      throw new ApiError(
        'provider_unavailable',
        'the storage provider could not complete the upload',
        { retryable: true },
      );
    }
  } else if (input.parts?.length) {
    throw new ApiError('validation_failed', 'this upload is not multipart');
  }

  const declaredSha256 =
    input.sha256 ?? (file.scanResult as { declaredSha256?: string } | null)?.declaredSha256 ?? null;
  const outcome = await inspectObject(location, file, declaredSha256);
  const log = logger();

  return withActor(db, ctx, async (tx) => {
    const guard = and(
      eq(schema.fileObjects.id, fileId),
      eq(schema.fileObjects.status, file.status),
      eq(schema.fileObjects.ownerUserId, userId),
    );
    if (outcome.reject) {
      const scanResult: FileScanRecord = {
        verdict: 'rejected',
        reason: outcome.reason ?? 'the file failed content inspection',
        inspection: { detectedMime: outcome.detectedMime, activeContent: outcome.activeContent },
      };
      const [updated] = await tx
        .update(schema.fileObjects)
        .set({
          status: 'rejected',
          sizeBytes: outcome.sizeBytes,
          checksumSha256: outcome.sha256 || null,
          detectedMime: outcome.detectedMime,
          scanResult,
          scannedAt: new Date(),
          retentionUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        })
        .where(guard)
        .returning();
      if (!updated) throw new ApiError('conflict', 'the file changed while it was being finalised');
      await recordAudit(tx, identity, {
        action: 'file.rejected',
        entityType: 'file',
        entityId: fileId,
        organizationId: file.organizationId,
        reason: scanResult.reason,
        after: { detectedMime: outcome.detectedMime, activeContent: outcome.activeContent },
        correlationId: options.correlationId,
      });
      log.warn(
        {
          fileId,
          purpose: file.purpose,
          reason: scanResult.reason,
          correlationId: options.correlationId,
        },
        'upload rejected at finalisation',
      );
      return { file: toFileDto(updated), outcome: 'rejected' };
    }
    const scanResult: FileScanRecord = {
      inspection: { detectedMime: outcome.detectedMime, activeContent: null },
      attempts: 0,
    };
    const [updated] = await tx
      .update(schema.fileObjects)
      .set({
        status: 'scanning',
        sizeBytes: outcome.sizeBytes,
        checksumSha256: outcome.sha256,
        detectedMime: outcome.detectedMime,
        scanResult,
        retentionUntil: null,
      })
      .where(guard)
      .returning();
    if (!updated) throw new ApiError('conflict', 'the file changed while it was being finalised');
    await appendOutbox(tx, {
      eventType: 'file.uploaded',
      aggregateType: 'file',
      aggregateId: fileId,
      organizationId: file.organizationId,
      actorUserId: userId,
      payload: { fileId, purpose: file.purpose, sizeBytes: outcome.sizeBytes },
      correlationId: options.correlationId,
    });
    await recordAudit(tx, identity, {
      action: 'file.finalized',
      entityType: 'file',
      entityId: fileId,
      organizationId: file.organizationId,
      after: {
        sizeBytes: outcome.sizeBytes,
        detectedMime: outcome.detectedMime,
        checksumVerified: Boolean(declaredSha256),
      },
      correlationId: options.correlationId,
    });
    return { file: toFileDto(updated), outcome: 'scanning' };
  });
}
