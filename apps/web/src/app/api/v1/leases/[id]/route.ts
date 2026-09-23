import { z } from 'zod';
import { ApiError, uuidSchema, leaseUpdateSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { getLease, updateLease } from '@/server/rentals/leases';
import '@/lib/api/registry/rentals';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });
export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, idParams);
  return json(await getLease(identity, id), { correlationId: ctx.correlationId });
});

export const PATCH = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, leaseUpdateSchema);
  return json(await updateLease(identity, id, body, { correlationId: ctx.correlationId }), { correlationId: ctx.correlationId });
});
