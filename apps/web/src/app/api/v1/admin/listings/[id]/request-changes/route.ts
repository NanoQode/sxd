import { z } from 'zod';
import { ApiError, listingReasonSchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { requestListingChanges } from '@/server/listings/moderation';
import '@/lib/api/registry/listings';

export const dynamic = 'force-dynamic';

/** POST /api/v1/admin/listings/:id/request-changes — send the submission back for edits (content.publish). */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, listingReasonSchema);
  return json(
    await requestListingChanges(identity, id, body, { correlationId: ctx.correlationId }),
    {
      correlationId: ctx.correlationId,
    },
  );
});
