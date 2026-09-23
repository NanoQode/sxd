import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import { ApiError, type FileGrantCreate, type FileGrantDto } from '@simplexd/contracts';
import { getDb, schema, withActor } from '@simplexd/db';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { elevated, requireFileAccess } from './access';
import { ctxFor, isSensitivePurpose, toGrantDto, userIdOf, type ServiceOptions } from './shared';

/**
 * Explicit access grants. Only the owner or staff with `files.read_all` may
 * grant; grants are revoked, never deleted, so the history stays auditable.
 * Sensitive documents can be granted to users only, never to organisations.
 */

export async function createGrant(
  identity: RequestIdentity,
  fileId: string,
  input: FileGrantCreate,
  options: ServiceOptions = {},
): Promise<FileGrantDto> {
  const userId = userIdOf(identity);
  const ctx = ctxFor(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const { file } = await requireFileAccess(tx, identity, ctx, fileId, 'manage');
    if (input.organizationId && isSensitivePurpose(file.purpose)) {
      throw new ApiError(
        'validation_failed',
        'sensitive documents can only be granted to individual users',
      );
    }
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new ApiError('validation_failed', 'expiresAt must be in the future', {
        details: [{ path: 'expiresAt', message: 'must be in the future' }],
      });
    }
    if (input.userId) {
      const [u] = await tx
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(eq(schema.user.id, input.userId));
      if (!u) throw new ApiError('not_found', 'user not found');
    } else if (input.organizationId) {
      const [o] = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, input.organizationId));
      if (!o) throw new ApiError('not_found', 'organisation not found');
    }
    // Inserted as the grantor under the caller's own context (grants policy: granted_by = app.user_id()).
    const [grant] = await tx
      .insert(schema.fileAccessGrants)
      .values({
        fileId,
        userId: input.userId ?? null,
        organizationId: input.organizationId ?? null,
        level: input.level,
        grantedBy: userId,
        expiresAt,
      })
      .returning();
    await recordAudit(tx, identity, {
      action: 'file.grant_created',
      entityType: 'file',
      entityId: fileId,
      organizationId: file.organizationId,
      after: {
        grantId: grant!.id,
        userId: input.userId ?? null,
        organizationId: input.organizationId ?? null,
        level: input.level,
        expiresAt,
      },
      correlationId: options.correlationId,
    });
    return toGrantDto(grant!);
  });
}

export async function revokeGrant(
  identity: RequestIdentity,
  fileId: string,
  grantId: string,
  options: ServiceOptions = {},
): Promise<FileGrantDto> {
  const ctx = ctxFor(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const { file } = await requireFileAccess(tx, identity, ctx, fileId, 'manage');
    const [grant] = await elevated(tx, ctx, () =>
      tx
        .select()
        .from(schema.fileAccessGrants)
        .where(
          and(eq(schema.fileAccessGrants.id, grantId), eq(schema.fileAccessGrants.fileId, fileId)),
        ),
    );
    if (!grant) throw new ApiError('not_found', 'grant not found');
    if (grant.revokedAt) return toGrantDto(grant);
    // The owner may revoke a grant staff created; the policy only lets the grantor write it.
    const [updated] = await elevated(tx, ctx, () =>
      tx
        .update(schema.fileAccessGrants)
        .set({ revokedAt: new Date() })
        .where(eq(schema.fileAccessGrants.id, grantId))
        .returning(),
    );
    await recordAudit(tx, identity, {
      action: 'file.grant_revoked',
      entityType: 'file',
      entityId: fileId,
      organizationId: file.organizationId,
      before: {
        grantId,
        userId: grant.userId,
        organizationId: grant.organizationId,
        level: grant.level,
      },
      correlationId: options.correlationId,
    });
    return toGrantDto(updated!);
  });
}

export async function listGrants(
  identity: RequestIdentity,
  fileId: string,
  options: ServiceOptions = {},
): Promise<FileGrantDto[]> {
  const ctx = ctxFor(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    await requireFileAccess(tx, identity, ctx, fileId, 'manage');
    const rows = await elevated(tx, ctx, () =>
      tx
        .select()
        .from(schema.fileAccessGrants)
        .where(eq(schema.fileAccessGrants.fileId, fileId))
        .orderBy(desc(schema.fileAccessGrants.createdAt)),
    );
    return rows.map(toGrantDto);
  });
}
