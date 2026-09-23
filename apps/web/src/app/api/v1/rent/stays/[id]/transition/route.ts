import { z } from 'zod';
import { ApiError, uuidSchema, stayBookingTransitionSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { requireFeature } from '@/lib/features';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { transitionStayBooking } from '@/server/rentals/stays';
import { FEATURES } from '@/server/rentals/shared';
import '@/lib/api/registry/rentals';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  requireFeature(identity, FEATURES.shortStay);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, stayBookingTransitionSchema);
  return json(
    await transitionStayBooking(identity, id, body, { correlationId: ctx.correlationId }),
    { status: 200, correlationId: ctx.correlationId },
  );
});
