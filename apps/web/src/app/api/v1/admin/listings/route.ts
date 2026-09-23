import { ApiError, listingListQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseQuery, route } from '@/lib/api/respond';
import { listListings } from '@/server/listings/owner';
import '@/lib/api/registry/listings';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/listings — moderation queue and every listing (content.publish, rentals.manage or customers.read). */
export const GET = route(async (req, { correlationId }) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  if (identity.actor.staffRoles.length === 0) throw new ApiError('forbidden', 'staff only');
  const query = parseQuery(req, listingListQuerySchema);
  return json({ items: await listListings(identity, query) }, { correlationId });
});
