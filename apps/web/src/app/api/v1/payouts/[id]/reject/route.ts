import { z } from 'zod';
import { ApiError, uuidSchema, payoutDecisionSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { rejectPayout } from '@/server/rentals/payouts';
import '@/lib/api/registry/rentals';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, payoutDecisionSchema);
  return json(await rejectPayout(identity, id, { reason: body.reason ?? 'rejected' }, { correlationId: ctx.correlationId }), { correlationId: ctx.correlationId });
});
