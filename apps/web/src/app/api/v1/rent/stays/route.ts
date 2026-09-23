import { ApiError, stayBookingCreateSchema, stayCalendarQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { requireFeature } from '@/lib/features';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import { createStayBooking, stayCalendar } from '@/server/rentals/stays';
import { FEATURES } from '@/server/rentals/shared';
import '@/lib/api/registry/rentals';

export const dynamic = 'force-dynamic';
/** GET /api/v1/rent/stays?propertyId&from&to — short-stay calendar. */
export const GET = route(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  requireFeature(identity, FEATURES.shortStay);
  return json(
    { items: await stayCalendar(identity, parseQuery(req, stayCalendarQuerySchema)) },
    { correlationId: ctx.correlationId },
  );
});

export const POST = route(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  requireFeature(identity, FEATURES.shortStay);
  const body = await parseJson(req, stayBookingCreateSchema);
  return json(await createStayBooking(identity, body, { correlationId: ctx.correlationId }), {
    status: 201,
    correlationId: ctx.correlationId,
  });
});
