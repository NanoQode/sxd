import { ApiError } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, route } from '@/lib/api/respond';
import { runListingExpiryNow } from '@/server/listings/jobs';
import '@/lib/api/registry/listings';

export const dynamic = 'force-dynamic';

/** POST /api/v1/admin/listings/expiry-runs — run the listing/offer expiry job now (rentals.manage or content.publish). */
export const POST = route(async (req, { correlationId }) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  return json(await runListingExpiryNow(identity, { correlationId }), { status: 201, correlationId });
});
