import { z } from 'zod';
import {
  ApiError,
  cursorPaginationQuerySchema,
  payoutProposeSchema,
  payoutStatusSchema,
} from '@simplexd/contracts';
import { withIdempotency } from '@/lib/api/idempotency';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import { getIdentity } from '@/lib/auth/session';
import { listPayouts, proposePayout } from '@/server/rentals/payouts';
import '@/lib/api/registry/rentals';

export const dynamic = 'force-dynamic';

const listQuery = cursorPaginationQuerySchema.extend({
  organizationId: z.string().min(1).max(64).optional(),
  status: payoutStatusSchema.optional(),
});

export const GET = route(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  return json(await listPayouts(identity, parseQuery(req, listQuery)), {
    correlationId: ctx.correlationId,
  });
});

/** POST /api/v1/payouts — propose an owner distribution from a reconciled statement (honours Idempotency-Key). */
export const POST = route(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const body = await parseJson(req, payoutProposeSchema);
  return withIdempotency(req, identity, 'POST /api/v1/payouts', body, async () =>
    json(await proposePayout(identity, body, { correlationId: ctx.correlationId }), {
      status: 201,
      correlationId: ctx.correlationId,
    }),
  );
});
