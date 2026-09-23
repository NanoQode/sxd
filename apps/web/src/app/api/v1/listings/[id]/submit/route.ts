import { z } from 'zod';
import { ApiError, listingVersionOnlySchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { submitListing } from '@/server/listings/owner';
import '@/lib/api/registry/listings';

export const dynamic = 'force-dynamic';

/** POST /api/v1/listings/:id/submit — submit the current revision for moderation (needs a verified owner authority). */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, listingVersionOnlySchema);
  return json(await submitListing(identity, id, body, { correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});
