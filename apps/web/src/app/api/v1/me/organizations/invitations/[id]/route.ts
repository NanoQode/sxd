import { z } from 'zod';
import { ApiError } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, route } from '@/lib/api/respond';
import { revokeInvitation } from '@/server/portal/organizations';

export const dynamic = 'force-dynamic';

/** DELETE /api/v1/me/organizations/invitations/:id — revoke a pending invitation. */
export const DELETE = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, z.object({ id: z.string().min(1).max(64) }));
  await revokeInvitation(identity, id, { correlationId: ctx.correlationId });
  return json({ id, status: 'canceled' }, { correlationId: ctx.correlationId });
});
