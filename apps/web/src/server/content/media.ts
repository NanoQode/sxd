import 'server-only';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  publicMediaPath,
  type ContentMediaAssetDto,
  type ContentMediaListResponse,
  type ContentMediaPendingDto,
  type PublicMediaVariant,
} from '@simplexd/contracts';
import { getDb, schema, withActor } from '@simplexd/db';
import type { RequestIdentity } from '@/lib/auth/session';
import { cached } from '@/lib/cache';
import { statusReasonOf, variantsOf } from '@/server/files/shared';

/**
 * Public content media. A file becomes publicly servable only when every
 * condition holds: purpose `content_media`, malware scan `clean`, object
 * promoted out of quarantine, `is_public_approved` on the file and
 * `approved_for_public` on its media asset, and the requested derivative
 * exists. Originals are never served; private purposes never match.
 */

const VARIANT_CONTENT_TYPE = 'image/webp';
const PUBLIC_MEDIA_TTL_SECONDS = 60;

export interface PublicMediaObject {
  assetId: string;
  fileId: string;
  bucket: 'derivatives';
  key: string;
  contentType: string;
  fileName: string;
  /** Strong validator for conditional requests (content checksum + variant). */
  etag: string;
  altText: string;
}

const publicContext = { userId: null, organizationId: null, staff: false, bypass: true } as const;

/**
 * Resolves an approved asset to the derivative object to stream. Cached for a
 * minute; approval changes clear the `content-media` prefix. Returns null for
 * anything that is not approved, clean, content media, or lacks the variant.
 */
export async function resolvePublicMedia(
  assetId: string,
  variant: PublicMediaVariant,
): Promise<PublicMediaObject | null> {
  return cached<PublicMediaObject | null>(
    `content-media:${assetId}:${variant}`,
    PUBLIC_MEDIA_TTL_SECONDS,
    async () => {
      const rows = await withActor(getDb(), publicContext, (tx) =>
        tx
          .select({ asset: schema.mediaAssets, file: schema.fileObjects })
          .from(schema.mediaAssets)
          .innerJoin(schema.fileObjects, eq(schema.fileObjects.id, schema.mediaAssets.fileId))
          .where(
            and(
              eq(schema.mediaAssets.id, assetId),
              eq(schema.mediaAssets.approvedForPublic, true),
              eq(schema.fileObjects.isPublicApproved, true),
              eq(schema.fileObjects.purpose, 'content_media'),
              eq(schema.fileObjects.status, 'clean'),
              eq(schema.fileObjects.bucket, 'private'),
              isNull(schema.fileObjects.deletedAt),
            ),
          )
          .limit(1),
      );
      const row = rows[0];
      if (!row) return null;
      const key = row.file.derivatives?.[variant];
      if (typeof key !== 'string' || !key) return null;
      const base = row.file.originalName.replace(/\.[^.]+$/, '') || 'image';
      return {
        assetId: row.asset.id,
        fileId: row.file.id,
        bucket: 'derivatives',
        key,
        contentType: VARIANT_CONTENT_TYPE,
        fileName: `${base}.${variant}.webp`,
        etag: `"${(row.file.checksumSha256 ?? row.file.id).slice(0, 32)}-${variant}"`,
        altText: row.asset.altText,
      };
    },
  );
}

/**
 * Media picker listing for content staff: approved assets with their public
 * URLs, plus content_media uploads that still need scanning, derivatives or
 * approval by someone other than the uploader. Private purposes are never
 * listed here.
 */
export async function listContentMedia(identity: RequestIdentity): Promise<ContentMediaListResponse> {
  return withActor(getDb(), identity.ctx, async (tx) => {
    const approvedRows = await tx
      .select({ m: schema.mediaAssets, f: schema.fileObjects })
      .from(schema.mediaAssets)
      .innerJoin(schema.fileObjects, eq(schema.fileObjects.id, schema.mediaAssets.fileId))
      .where(
        and(
          eq(schema.mediaAssets.approvedForPublic, true),
          eq(schema.fileObjects.isPublicApproved, true),
          eq(schema.fileObjects.status, 'clean'),
          eq(schema.fileObjects.purpose, 'content_media'),
          isNull(schema.fileObjects.deletedAt),
        ),
      )
      .orderBy(asc(schema.mediaAssets.createdAt))
      .limit(200);
    const items: ContentMediaAssetDto[] = approvedRows.map((r) => ({
      id: r.m.id,
      fileId: r.m.fileId,
      altText: r.m.altText,
      caption: r.m.caption,
      originalName: r.f.originalName,
      declaredMime: r.f.declaredMime,
      approvedForPublic: r.m.approvedForPublic,
      rightsConfirmed: r.m.rightsConfirmed,
      uploadedBy: r.m.uploadedBy,
      publicUrl: publicMediaPath(r.m.id, 'web'),
      thumbUrl: publicMediaPath(r.m.id, 'thumb'),
      createdAt: r.m.createdAt.toISOString(),
    }));
    const pendingRows = await tx
      .select({ f: schema.fileObjects, ownerName: schema.user.name })
      .from(schema.fileObjects)
      .leftJoin(schema.user, eq(schema.user.id, schema.fileObjects.ownerUserId))
      .where(
        and(
          eq(schema.fileObjects.purpose, 'content_media'),
          eq(schema.fileObjects.isPublicApproved, false),
          inArray(schema.fileObjects.status, ['uploaded', 'scanning', 'clean', 'scan_failed', 'rejected', 'infected']),
          isNull(schema.fileObjects.deletedAt),
        ),
      )
      .orderBy(desc(schema.fileObjects.createdAt))
      .limit(100);
    const pending: ContentMediaPendingDto[] = pendingRows.map((r) => ({
      fileId: r.f.id,
      originalName: r.f.originalName,
      declaredMime: r.f.declaredMime,
      status: r.f.status,
      statusReason: statusReasonOf(r.f),
      hasWebVariant: variantsOf(r.f).includes('web'),
      ownerUserId: r.f.ownerUserId,
      ownerName: r.ownerName ?? null,
      createdAt: r.f.createdAt.toISOString(),
    }));
    return { items, pending };
  });
}
