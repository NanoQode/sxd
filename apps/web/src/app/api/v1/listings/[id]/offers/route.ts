import { z } from 'zod';
import { ApiError, listingOfferCreateSchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { createListingOffer, listOffersForListing } from '@/server/listings/offers';
import '@/lib/api/registry/listings';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };
const idParams = z.object({ id: uuidSchema });

/** GET /api/v1/listings/:id/offers — offers on the listing visible to the caller. */
export const GET = route<Ctx>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, idParams);
  return json(
    { items: await listOffersForListing(identity, id) },
    { correlationId: ctx.correlationId },
  );
});

/** POST /api/v1/listings/:id/offers — the active organisation makes an offer. */
export const POST = route<Ctx>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, listingOfferCreateSchema);
  return json(await createListingOffer(identity, id, body, { correlationId: ctx.correlationId }), {
    status: 201,
    correlationId: ctx.correlationId,
  });
});
