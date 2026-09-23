import { requireStaff } from '@/lib/auth/session';
import { json, route } from '@/lib/api/respond';
import { runTestBooking } from '@/server/calendar/admin';

export const dynamic = 'force-dynamic';

/** POST /api/v1/admin/calendar/test-booking — create and delete a real event through the provider; reports the real result. */
export const POST = route(async (_req, { correlationId }) => {
  const identity = await requireStaff('appointments.test_booking');
  return json(await runTestBooking(identity, { correlationId }), { correlationId });
});
