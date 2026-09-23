import 'server-only';
import { eq } from 'drizzle-orm';
import { ApiError, type NoteDto } from '@simplexd/contracts';
import { getDb, schema, withActor } from '@simplexd/db';
import type { RequestIdentity } from '@/lib/auth/session';
import { assertOrgPermission } from '@/server/portal/access';
import { loadServiceRequest, toNoteDto } from './queries';

/**
 * Customer notes on a request are always customer-visible (never internal), so
 * the organisation's members and the assigned team both see them.
 */
export async function addCustomerNote(
  identity: RequestIdentity,
  id: string,
  body: string,
): Promise<NoteDto> {
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const userId = identity.session.user.id;
  return withActor(getDb(), identity.ctx, async (tx) => {
    const row = await loadServiceRequest(tx, id);
    if (!row) throw new ApiError('not_found', 'request not found');
    assertOrgPermission(identity, 'org.comment', {
      type: 'service_request',
      id: row.sr.id,
      organizationId: row.sr.organizationId,
    });
    const [note] = await tx
      .insert(schema.notes)
      .values({
        organizationId: row.sr.organizationId,
        entityType: 'service_request',
        entityId: row.sr.id,
        body,
        visibility: 'customer',
        authorUserId: userId,
      })
      .returning();
    const [author] = await tx
      .select({ name: schema.user.name })
      .from(schema.user)
      .where(eq(schema.user.id, userId));
    return toNoteDto(note!, author?.name ?? null);
  });
}
