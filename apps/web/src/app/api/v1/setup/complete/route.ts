import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '@simplexd/contracts';
import { getDb, schema, systemContext, withActor } from '@simplexd/db';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ token: z.string().min(20).max(200) });

/** Completes the first-administrator bootstrap: token must match the signed-in email. */
export const POST = route(async (req, { correlationId }) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { token } = await parseJson(req, bodySchema);
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const userId = identity.session.user.id;
  const email = identity.session.user.email.toLowerCase();
  const result = await withActor(getDb(), systemContext(correlationId), async (tx) => {
    const rows = await tx
      .select()
      .from(schema.setupTokens)
      .where(eq(schema.setupTokens.tokenHash, tokenHash));
    const row = rows[0];
    if (!row || row.purpose !== 'first_admin')
      throw new ApiError('not_found', 'setup token not found');
    if (row.usedAt) throw new ApiError('conflict', 'setup token already used');
    if (row.expiresAt.getTime() < Date.now()) throw new ApiError('conflict', 'setup token expired');
    if (row.email.toLowerCase() !== email)
      throw new ApiError('forbidden', 'this setup link was issued for a different email address');
    await tx
      .update(schema.setupTokens)
      .set({ usedAt: new Date() })
      .where(eq(schema.setupTokens.id, row.id));
    await tx
      .insert(schema.staffRoles)
      .values({ userId, role: 'super_admin', reason: 'first administrator bootstrap' })
      .onConflictDoNothing();
    await tx.update(schema.user).set({ emailVerified: true }).where(eq(schema.user.id, userId));
    await tx.insert(schema.auditEvents).values({
      actorType: 'user',
      actorUserId: userId,
      action: 'staff_role.granted',
      entityType: 'user',
      entityId: userId,
      after: { role: 'super_admin' },
      reason: 'first administrator bootstrap',
      correlationId,
    });
    return { granted: 'super_admin' };
  });
  return json(result, { correlationId });
});
