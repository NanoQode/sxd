import { z } from 'zod';
import { ApiError, listingOutcomeSchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { recordListingOutcome } from '@/server/listings/transactions';
import '@/lib/api/registry/listings';

export const dynamic = 'force-dynamic';

/** POST /api/v1/listings/:id/outcome — record the documented sale, lease or withdrawal. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, listingOutcomeSchema);
  return json(await recordListingOutcome(identity, id, body, { correlationId: ctx.correlationId }), {
    status: 201,
    correlationId: ctx.correlationId,
  });
});
