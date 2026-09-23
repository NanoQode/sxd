import { z } from 'zod';
import { ApiError, uuidSchema, purchaseOfferCreateSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import '@/lib/api/registry/search-purchase';
import { createPurchaseOffer, listPurchaseOffers } from '@/server/purchase/offers';

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
  return json(
    { items: await listPurchaseOffers(identity, id) },
    { correlationId: ctx.correlationId },
  );
});

/** POST /api/v1/service-requests/:id/purchase/offers — draft an offer for the represented buyer. */
export const POST = route<Ctx>(async (req, ctx) => {
  const identity = await identityOrThrow();
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, purchaseOfferCreateSchema);
  const dto = await createPurchaseOffer(identity, id, body, { correlationId: ctx.correlationId });
  return json(dto, { status: 201, correlationId: ctx.correlationId });
});
