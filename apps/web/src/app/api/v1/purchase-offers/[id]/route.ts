import { z } from 'zod';
import { ApiError, uuidSchema, purchaseOfferUpdateSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import '@/lib/api/registry/search-purchase';
import { getPurchaseOffer, updatePurchaseOffer } from '@/server/purchase/offers';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

async function identityOrThrow() {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  return identity;
}

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, ctx) => {
  const identity = await identityOrThrow();
  const { id } = await params(ctx, idParams);
  return json(await getPurchaseOffer(identity, id), { correlationId: ctx.correlationId });
});

/** PATCH /api/v1/purchase-offers/:id — edit a draft (logged as `amended`). */
export const PATCH = route<Ctx>(async (req, ctx) => {
  const identity = await identityOrThrow();
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, purchaseOfferUpdateSchema);
  return json(await updatePurchaseOffer(identity, id, body, { correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});
