import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import {
  ApiError,
  type OwnerAuthorityDto,
  type OwnerAuthorityReject,
  type OwnerAuthoritySubmit,
  type OwnerAuthorityVerify,
} from '@simplexd/contracts';
import { getDb, schema, withActor, type DbExecutor } from '@simplexd/db';
import { assertAllowed, authorizeStaff } from '@simplexd/domain/authz';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import {
  actorContext,
  requireUserId,
  type ServiceOptions,
} from '@/server/assignments/shared';
import { requireProperty } from './access';
import { toOwnerAuthorityDto } from './dto';

type AuthorityRow = typeof schema.ownerAuthorities.$inferSelect;

/**
 * Owner authority: the customer submits proof that they may act for the
 * owner (a document in the same organisation's file store); staff verify or
 * reject it. Verification is a rentals/listings moderation duty, so it needs
 * `rentals.manage` (held by operations, finance and super administrators,
 * never by customers or partners). A verified authority lapses at `expiresAt`
 * and reads as `expired` from then on.
 */

/** Files the scanner has not rejected; pending_upload rows have no content yet. */
const USABLE_FILE_STATUSES = new Set(['uploaded', 'scanning', 'clean']);

export async function assertUsableFile(
  tx: DbExecutor,
  fileId: string,
  organizationId: string,
  path: string,
): Promise<void> {
  const [file] = await tx
    .select({
      id: schema.fileObjects.id,
      organizationId: schema.fileObjects.organizationId,
      status: schema.fileObjects.status,
      deletedAt: schema.fileObjects.deletedAt,
    })
    .from(schema.fileObjects)
    .where(eq(schema.fileObjects.id, fileId));
  if (!file || file.organizationId !== organizationId) {
    throw new ApiError('validation_failed', 'document must be a file of the same organisation', {
      details: [{ path, message: 'unknown file for this organisation' }],
    });
  }
  if (file.status === 'infected' || file.status === 'scan_failed') {
    throw new ApiError('file_quarantined', 'the document is quarantined and cannot be used');
  }
  if (file.deletedAt || !USABLE_FILE_STATUSES.has(file.status)) {
    throw new ApiError('file_rejected', 'the document was rejected, deleted or never uploaded');
  }
}

async function loadAuthority(
  tx: DbExecutor,
  propertyId: string,
  authorityId: string,
): Promise<AuthorityRow | null> {
  const rows = await tx
    .select()
    .from(schema.ownerAuthorities)
    .where(
      and(
        eq(schema.ownerAuthorities.id, authorityId),
        eq(schema.ownerAuthorities.propertyId, propertyId),
      ),
    );
  return rows[0] ?? null;
}

export async function listOwnerAuthorities(
  identity: RequestIdentity,
  propertyId: string,
): Promise<OwnerAuthorityDto[]> {
  requireUserId(identity);
  return withActor(getDb(), identity.ctx, async (tx) => {
    await requireProperty(tx, identity, propertyId, 'read');
    const rows = await tx
      .select()
      .from(schema.ownerAuthorities)
      .where(eq(schema.ownerAuthorities.propertyId, propertyId))
      .orderBy(desc(schema.ownerAuthorities.createdAt), desc(schema.ownerAuthorities.id));
    const now = new Date();
    return rows.map((r) => toOwnerAuthorityDto(r, now));
  });
}

export async function submitOwnerAuthority(
  identity: RequestIdentity,
  propertyId: string,
  input: OwnerAuthoritySubmit,
  options: ServiceOptions = {},
): Promise<OwnerAuthorityDto> {
  requireUserId(identity);
  const ctx = actorContext(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const property = await requireProperty(tx, identity, propertyId, 'manage');
    // Read under the caller's own context: the file must be visible to them and belong to the same organisation.
    await assertUsableFile(tx, input.authorityDocumentFileId, property.organizationId, 'authorityDocumentFileId');
    const [row] = await tx
      .insert(schema.ownerAuthorities)
      .values({
        organizationId: property.organizationId,
        propertyId,
        ownerName: input.ownerName,
        authorityDocumentFileId: input.authorityDocumentFileId,
        status: 'pending',
        note: input.note ?? null,
      })
      .returning();
    await recordAudit(tx, identity, {
      action: 'owner_authority.submitted',
      entityType: 'owner_authority',
      entityId: row!.id,
      organizationId: property.organizationId,
      after: { propertyId, ownerName: input.ownerName, fileId: input.authorityDocumentFileId },
      correlationId: options.correlationId,
    });
    return toOwnerAuthorityDto(row!);
  });
}

function assertCanVerify(identity: RequestIdentity, organizationId: string, id: string): void {
  assertAllowed(
    authorizeStaff(identity.actor, 'rentals.manage', { type: 'owner_authority', id, organizationId }),
  );
}

export async function verifyOwnerAuthority(
  identity: RequestIdentity,
  propertyId: string,
  authorityId: string,
  input: OwnerAuthorityVerify,
  options: ServiceOptions = {},
): Promise<OwnerAuthorityDto> {
  const userId = requireUserId(identity);
  const ctx = actorContext(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const property = await requireProperty(tx, identity, propertyId, 'read');
    const current = await loadAuthority(tx, propertyId, authorityId);
    if (!current) throw new ApiError('not_found', 'owner authority not found');
    assertCanVerify(identity, property.organizationId, current.id);
    if (current.status !== 'pending') {
      throw new ApiError('invalid_transition', `owner authority is already ${current.status}`);
    }
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new ApiError('validation_failed', 'expiresAt must be in the future', {
        details: [{ path: 'expiresAt', message: 'must be in the future' }],
      });
    }
    const [row] = await tx
      .update(schema.ownerAuthorities)
      .set({
        status: 'verified',
        verifiedBy: userId,
        verifiedAt: new Date(),
        expiresAt,
        note: input.note ?? current.note,
      })
      .where(and(eq(schema.ownerAuthorities.id, authorityId), eq(schema.ownerAuthorities.status, 'pending')))
      .returning();
    if (!row) throw new ApiError('invalid_transition', 'owner authority changed while verifying');
    await recordAudit(tx, identity, {
      action: 'owner_authority.verified',
      entityType: 'owner_authority',
      entityId: authorityId,
      organizationId: property.organizationId,
      before: { status: 'pending' },
      after: { status: 'verified', expiresAt: expiresAt?.toISOString() ?? null },
      correlationId: options.correlationId,
    });
    return toOwnerAuthorityDto(row);
  });
}

export async function rejectOwnerAuthority(
  identity: RequestIdentity,
  propertyId: string,
  authorityId: string,
  input: OwnerAuthorityReject,
  options: ServiceOptions = {},
): Promise<OwnerAuthorityDto> {
  const userId = requireUserId(identity);
  const ctx = actorContext(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const property = await requireProperty(tx, identity, propertyId, 'read');
    const current = await loadAuthority(tx, propertyId, authorityId);
    if (!current) throw new ApiError('not_found', 'owner authority not found');
    assertCanVerify(identity, property.organizationId, current.id);
    if (current.status !== 'pending') {
      throw new ApiError('invalid_transition', `owner authority is already ${current.status}`);
    }
    const [row] = await tx
      .update(schema.ownerAuthorities)
      .set({ status: 'rejected', verifiedBy: userId, verifiedAt: new Date(), note: input.reason })
      .where(and(eq(schema.ownerAuthorities.id, authorityId), eq(schema.ownerAuthorities.status, 'pending')))
      .returning();
    if (!row) throw new ApiError('invalid_transition', 'owner authority changed while rejecting');
    await recordAudit(tx, identity, {
      action: 'owner_authority.rejected',
      entityType: 'owner_authority',
      entityId: authorityId,
      organizationId: property.organizationId,
      before: { status: 'pending' },
      after: { status: 'rejected' },
      reason: input.reason,
      correlationId: options.correlationId,
    });
    return toOwnerAuthorityDto(row);
  });
}
