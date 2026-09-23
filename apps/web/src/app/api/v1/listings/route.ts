import { ApiError, listingCreateSchema, listingListQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import { createListing, listListings } from '@/server/listings/owner';
import '@/lib/api/registry/listings';

export const dynamic = 'force-dynamic';

/** GET /api/v1/listings — the active organisation's listings (staff: all, with filters). */
export const GET = route(async (req, { correlationId }) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const query = parseQuery(req, listingListQuerySchema);
  return json({ items: await listListings(identity, query) }, { correlationId });
});

/** POST /api/v1/listings — create a draft listing (revision 1) for one of the organisation's properties. */
export const POST = route(async (req, { correlationId }) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const body = await parseJson(req, listingCreateSchema);
  return json(await createListing(identity, body, { correlationId }), {
    status: 201,
    correlationId,
  });
});
