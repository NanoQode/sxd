import { z } from 'zod';
import { ApiError, payoutSettleSchema, uuidSchema } from '@simplexd/contracts';
import { withIdempotency } from '@/lib/api/idempotency';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { getIdentity } from '@/lib/auth/session';
import { settlePayout } from '@/server/rentals/payouts';
import '@/lib/api/registry/rentals';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

/** POST /api/v1/payouts/:id/settle — `finance.reconcile`; posts `payout:<id>:settled` (honours Idempotency-Key). */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, payoutSettleSchema);
  return withIdempotency(req, identity, `POST /api/v1/payouts/${id}/settle`, body, async () =>
    json(await settlePayout(identity, id, body, { correlationId: ctx.correlationId }), {
      correlationId: ctx.correlationId,
    }),
  );
});
