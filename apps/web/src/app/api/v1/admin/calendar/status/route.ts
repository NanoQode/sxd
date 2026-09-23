import { requireStaff } from '@/lib/auth/session';
import { json, route } from '@/lib/api/respond';
import { getCalendarStatus } from '@/server/calendar/admin';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/calendar/status — adapter, redirect URI, organiser grants and sync health (honest states). */
export const GET = route(async (_req, { correlationId }) => {
  const identity = await requireStaff('appointments.manage_all');
  return json(await getCalendarStatus(identity), { correlationId });
});
