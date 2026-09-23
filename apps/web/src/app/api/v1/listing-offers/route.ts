import { ApiError, listingOfferListQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseQuery, route } from '@/lib/api/respond';
import { listMyListingOffers } from '@/server/listings/offers';
import '@/lib/api/registry/listings';

export const dynamic = 'force-dynamic';

/** GET /api/v1/listing-offers — the active organisation's offers, as buyer and as owner. */
export const GET = route(async (req, { correlationId }) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const query = parseQuery(req, listingOfferListQuerySchema);
  return json({ items: await listMyListingOffers(identity, query) }, { correlationId });
});
