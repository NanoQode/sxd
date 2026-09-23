import 'server-only';
import {
  ApiError,
  DOWNLOAD_URL_DEFAULT_SECONDS,
  DOWNLOAD_URL_MAX_SECONDS,
  type FileDownloadQuery,
  type FileDownloadResponse,
} from '@simplexd/contracts';
import { getDb, schema, withActor } from '@simplexd/db';
import { StorageError, type ObjectLocation } from '@simplexd/integrations/storage';
import type { RequestIdentity } from '@/lib/auth/session';
import { logger } from '@/lib/logger';
import { requireFileAccess } from './access';
import { ctxFor, unavailableError, userIdOf, type ServiceOptions } from './shared';
import { getStorage } from './storage';

/**
 * Signed download issuance. Access is checked on every call (memberships and
 * grants are re-read), only `clean` files in the private/derivatives buckets
 * are served, the URL lives 5 minutes by default (15 max) and every issuance
 * is written to the append-only `file_download_log`.
 */

const VARIANT_CONTENT_TYPE = 'image/webp';

export async function issueDownload(
  identity: RequestIdentity,
  fileId: string,
  query: FileDownloadQuery,
  options: ServiceOptions = {},
): Promise<FileDownloadResponse> {
  const userId = userIdOf(identity);
  const ctx = ctxFor(identity, options);
  const storage = getStorage();
  const level = query.variant ? 'view' : 'download';
  return withActor(getDb(), ctx, async (tx) => {
    const { file } = await requireFileAccess(tx, identity, ctx, fileId, level);
    if (file.status !== 'clean' || file.bucket === 'quarantine') throw unavailableError(file);
    let location: ObjectLocation;
    let contentType: string;
    let fileName = file.originalName;
    if (query.variant) {
      const key = file.derivatives?.[query.variant];
      if (typeof key !== 'string') {
        throw new ApiError('not_found', `no ${query.variant} variant exists for this file`, {
          details: { fileId, variant: query.variant },
        });
      }
      location = { bucket: 'derivatives', key };
      contentType = VARIANT_CONTENT_TYPE;
      fileName = `${file.originalName.replace(/\.[^.]+$/, '')}.${query.variant}.webp`;
    } else {
      location = { bucket: file.bucket, key: file.storageKey };
      contentType = file.detectedMime ?? file.declaredMime;
    }
    const expiresInSeconds = Math.min(
      query.expiresIn ?? DOWNLOAD_URL_DEFAULT_SECONDS,
      DOWNLOAD_URL_MAX_SECONDS,
    );
    let signed;
    try {
      signed = await storage.createSignedDownloadUrl({
        ...location,
        fileName,
        contentType,
        // The provider downgrades to attachment for anything that is not inline-safe.
        contentDisposition: query.disposition ?? (query.variant ? 'inline' : 'attachment'),
        expiresInSeconds,
      });
    } catch (err) {
      if (err instanceof StorageError && err.code === 'quarantined')
        throw unavailableError({ ...file, status: 'scanning' });
      throw new ApiError(
        'provider_unavailable',
        'the storage provider could not sign the download',
        { retryable: true },
      );
    }
    await tx.insert(schema.fileDownloadLog).values({
      fileId,
      userId,
      ipHash: options.ipHash ?? null,
      purpose: query.variant ? `variant:${query.variant}` : 'original',
    });
    // Logs carry ids and sizes only: never the signed URL or file contents.
    logger().info(
      {
        fileId,
        userId,
        variant: query.variant ?? null,
        expiresInSeconds,
        correlationId: options.correlationId,
      },
      'signed download issued',
    );
    return {
      url: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
      contentType: signed.contentType,
      contentDisposition: signed.contentDisposition,
    };
  });
}
