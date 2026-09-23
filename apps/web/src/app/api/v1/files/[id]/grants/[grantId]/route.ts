import { z } from 'zod';
import { ApiError, uuidSchema } from '@simplexd/contracts';
import { json, params, route } from '@/lib/api/respond';
import { getIdentity } from '@/lib/auth/session';
import { revokeGrant } from '@/server/files/grants';
import '@/lib/api/registry/files';

export const dynamic = 'force-dynamic';

/** DELETE /api/v1/files/:id/grants/:grantId — revoke a grant (kept for audit). */
export const DELETE = route<{ params: Promise<{ id: string; grantId: string }> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id, grantId } = await params(ctx, z.object({ id: uuidSchema, grantId: uuidSchema }));
  return json(await revokeGrant(identity, id, grantId, { correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});
