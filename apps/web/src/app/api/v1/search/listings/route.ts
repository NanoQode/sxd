import { ApiError, searchListingQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseQuery, route } from '@/lib/api/respond';
import '@/lib/api/registry/search-purchase';
import { searchPublishedListings } from '@/server/search/saved-searches';

export const dynamic = 'force-dynamic';

async function identityOrThrow() {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  return identity;
}

/** GET /api/v1/search/listings?q= — published listings for the shortlist picker. */
export const GET = route(async (req, ctx) => {
  const identity = await identityOrThrow();
  const query = parseQuery(req, searchListingQuerySchema);
  return json(
    { items: await searchPublishedListings(identity, query) },
    { correlationId: ctx.correlationId },
  );
});
