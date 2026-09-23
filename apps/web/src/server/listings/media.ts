import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { ApiError, DOWNLOAD_URL_DEFAULT_SECONDS } from '@simplexd/contracts';
import { getDb, schema, systemContext, withActor } from '@simplexd/db';
import { StorageError } from '@simplexd/integrations/storage';
import { getStorage } from '@/server/files/storage';
import { loadPublicListingFacts } from './public';

/**
 * Public listing photos. Only a publicly approved derivative (`web` or
 * `thumb`) of a clean image that the published revision references is
 * served, through a short-lived signed URL; originals never leave the
 * private bucket. Every issuance is logged like any other download.
 */
export async function issuePublicListingMedia(
  slug: string,
  fileId: string,
  variant: 'web' | 'thumb',
): Promise<{ url: string; expiresAt: string; contentType: string }> {
  const listing = await loadPublicListingFacts({ slug });
  if (!listing || !listing.visible) throw new ApiError('not_found', 'listing not found');
  const storage = getStorage();
  return withActor(getDb(), systemContext('public-listing-media'), async (tx) => {
    const [row] = await tx
      .select({ file: schema.fileObjects })
      .from(schema.listings)
      .innerJoin(
        schema.listingRevisions,
        and(
          eq(schema.listingRevisions.listingId, schema.listings.id),
          eq(schema.listingRevisions.version, sql`${schema.listings.publishedVersion}`),
        ),
      )
      .innerJoin(schema.fileObjects, eq(schema.fileObjects.id, fileId))
      .innerJoin(schema.mediaAssets, eq(schema.mediaAssets.fileId, schema.fileObjects.id))
      .where(
        and(
          eq(schema.listings.id, listing.id),
          sql`${schema.listingRevisions.mediaFileIds} @> ${JSON.stringify([fileId])}::jsonb`,
          eq(schema.fileObjects.isPublicApproved, true),
          eq(schema.fileObjects.status, 'clean'),
          sql`${schema.fileObjects.deletedAt} is null`,
          eq(schema.mediaAssets.approvedForPublic, true),
        ),
      );
    const key = row?.file.derivatives?.[variant];
    if (!row || typeof key !== 'string') throw new ApiError('not_found', 'photo not available');
    let signed;
    try {
      signed = await storage.createSignedDownloadUrl({
        bucket: 'derivatives',
        key,
        fileName: `${row.file.originalName.replace(/\.[^.]+$/, '')}.${variant}.webp`,
        contentType: 'image/webp',
        contentDisposition: 'inline',
        expiresInSeconds: DOWNLOAD_URL_DEFAULT_SECONDS,
      });
    } catch (err) {
      if (err instanceof StorageError) {
        throw new ApiError('provider_unavailable', 'the storage provider could not sign the photo', {
          retryable: true,
        });
      }
      throw err;
    }
    await tx.insert(schema.fileDownloadLog).values({
      fileId,
      userId: null,
      ipHash: null,
      purpose: `public-listing:${variant}`,
    });
    return {
      url: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
      contentType: signed.contentType,
    };
  });
}
