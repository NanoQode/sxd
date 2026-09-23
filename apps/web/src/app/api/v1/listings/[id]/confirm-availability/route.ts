import { z } from 'zod';
import { ApiError, listingVersionOnlySchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { confirmListingAvailability } from '@/server/listings/owner';
import '@/lib/api/registry/listings';

export const dynamic = 'force-dynamic';

/** POST /api/v1/listings/:id/confirm-availability — re-confirm availability and restart the window. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, listingVersionOnlySchema);
  return json(await confirmListingAvailability(identity, id, body, { correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});
