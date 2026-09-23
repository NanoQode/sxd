import { z } from 'zod';
import { ApiError, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, route } from '@/lib/api/respond';
import { getAssignment } from '@/server/assignments/service';
import '@/lib/api/registry/collaboration';

export const dynamic = 'force-dynamic';

/** GET /api/v1/assignments/:id */
export const GET = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  return json(await getAssignment(identity, id), { correlationId: ctx.correlationId });
});
