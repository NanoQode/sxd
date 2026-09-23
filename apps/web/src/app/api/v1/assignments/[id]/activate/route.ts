import { z } from 'zod';
import { ApiError, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, route } from '@/lib/api/respond';
import { activateAssignment } from '@/server/assignments/service';
import '@/lib/api/registry/collaboration';

export const dynamic = 'force-dynamic';

/** POST /api/v1/assignments/:id/activate */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  return json(await activateAssignment(identity, id, { correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});
