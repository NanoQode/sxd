import 'server-only';
import { eq } from 'drizzle-orm';
import {
  ApiError,
  type FilePublicApproval,
  type FilePublicApprovalResponse,
} from '@simplexd/contracts';
import { getDb, schema, withActor } from '@simplexd/db';
import { assertAllowed, authorizeAny } from '@simplexd/domain/authz';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { loadFileAccess } from './access';
import {
  ctxFor,
  isSensitivePurpose,
  notFound,
  toFileDto,
  userIdOf,
  variantsOf,
  type ServiceOptions,
} from './shared';

/**
 * Public approval. `is_public_approved` means the file's *derivatives* may be
 * referenced by public pages; originals are never public and sensitive
 * documents can never be approved. Approval needs a clean image with a web
 * derivative, alt text and a rights confirmation, and it is recorded as a
 * `media_assets` row for the CMS media picker. Staff cannot approve their own
 * uploads (`evidence.approve` separation of duties).
 */
export async function setPublicApproval(
  identity: RequestIdentity,
  fileId: string,
  input: FilePublicApproval,
  options: ServiceOptions = {},
): Promise<FilePublicApprovalResponse> {
  const userId = userIdOf(identity);
  const ctx = ctxFor(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const access = await loadFileAccess(tx, ctx, fileId);
    if (!access) throw notFound();
    const { file } = access;
    // Separation of duties for both permissions: nobody publishes their own upload.
    if (file.ownerUserId === userId)
      throw new ApiError('forbidden', 'you cannot approve your own upload for public use');
    assertAllowed(
      authorizeAny(
        identity.actor,
        [{ staff: 'evidence.approve' }, { staff: 'content.media.manage' }],
        {
          type: 'file',
          id: file.id,
          organizationId: file.organizationId,
          createdBy: file.ownerUserId,
        },
      ),
    );
    let altText: string | null = null;
    if (input.approved) {
      altText = input.altText ?? null;
      if (!altText || input.rightsConfirmed !== true) {
        throw new ApiError(
          'validation_failed',
          'approving for public use requires altText and rightsConfirmed=true',
          {
            details: [
              {
                path: 'rightsConfirmed',
                message: 'alt text and a rights confirmation are required',
              },
            ],
          },
        );
      }
      if (isSensitivePurpose(file.purpose))
        throw new ApiError('forbidden', 'sensitive documents can never be approved for public use');
      if (file.status !== 'clean')
        throw new ApiError(
          'file_quarantined',
          'only files that passed malware scanning can be approved',
          { details: { status: file.status } },
        );
      const mime = file.detectedMime ?? file.declaredMime;
      if (!mime.startsWith('image/'))
        throw new ApiError(
          'validation_failed',
          'only images can be approved for public use (originals of documents and video are never public)',
        );
      if (!variantsOf(file).includes('web'))
        throw new ApiError(
          'conflict',
          'the web derivative has not been generated yet; retry shortly',
          { retryable: true },
        );
    }
    const [updated] = await tx
      .update(schema.fileObjects)
      .set({ isPublicApproved: input.approved })
      .where(eq(schema.fileObjects.id, fileId))
      .returning();
    const [existing] = await tx
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.fileId, fileId));
    let asset = existing ?? null;
    if (input.approved && altText) {
      const values = {
        altText,
        caption: input.caption ?? existing?.caption ?? null,
        rightsNote: input.rightsNote ?? existing?.rightsNote ?? null,
        rightsConfirmed: true,
        approvedForPublic: true,
        approvedBy: userId,
      };
      if (existing) {
        const rows = await tx
          .update(schema.mediaAssets)
          .set(values)
          .where(eq(schema.mediaAssets.id, existing.id))
          .returning();
        asset = rows[0] ?? null;
      } else {
        const rows = await tx
          .insert(schema.mediaAssets)
          .values({ fileId, uploadedBy: file.ownerUserId, ...values })
          .returning();
        asset = rows[0] ?? null;
      }
    } else if (existing) {
      const rows = await tx
        .update(schema.mediaAssets)
        .set({
          approvedForPublic: false,
          approvedBy: null,
          ...(input.altText ? { altText: input.altText } : {}),
          ...(input.caption !== undefined ? { caption: input.caption } : {}),
          ...(input.rightsConfirmed !== undefined
            ? { rightsConfirmed: input.rightsConfirmed }
            : {}),
          ...(input.rightsNote !== undefined ? { rightsNote: input.rightsNote } : {}),
        })
        .where(eq(schema.mediaAssets.id, existing.id))
        .returning();
      asset = rows[0] ?? null;
    }
    await recordAudit(tx, identity, {
      action: input.approved ? 'file.public_approved' : 'file.public_revoked',
      entityType: 'file',
      entityId: fileId,
      organizationId: file.organizationId,
      before: { isPublicApproved: file.isPublicApproved },
      after: {
        isPublicApproved: input.approved,
        mediaAssetId: asset?.id ?? null,
        rightsConfirmed: asset?.rightsConfirmed ?? null,
      },
      correlationId: options.correlationId,
    });
    return {
      file: toFileDto(updated!),
      mediaAsset: asset
        ? {
            id: asset.id,
            altText: asset.altText,
            caption: asset.caption,
            rightsConfirmed: asset.rightsConfirmed,
            approvedForPublic: asset.approvedForPublic,
          }
        : null,
    };
  });
}
