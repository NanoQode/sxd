import { z } from 'zod';
import { ApiError, uuidSchema, purchaseOfferActionSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, parseQuery, route } from '@/lib/api/respond';
import '@/lib/api/registry/search-purchase';
import { applyPurchaseOfferAction } from '@/server/purchase/offers';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

async function identityOrThrow() {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  return identity;
}

/** POST /api/v1/purchase-offers/:id/actions — submit, counter, revise, accept, reject, withdraw, expire or note. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await identityOrThrow();
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, purchaseOfferActionSchema);
  return json(await applyPurchaseOfferAction(identity, id, body, { correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});
