import 'server-only';
import { asc, eq } from 'drizzle-orm';
import type { AppointmentDto, AppointmentListQuery, CalendarStatusDto } from '@simplexd/contracts';
import { schema } from '@simplexd/db';
import type { RequestIdentity } from '@/lib/auth/session';
import { viewerFromIdentity } from '@/server/appointments/access';
import { listAppointments } from '@/server/appointments/queries';
import { getCalendarStatus } from '@/server/calendar/admin';
import { listStaffAssignees } from '@/server/leads/admin';
import { can, requireAnyStaff, staffTx } from './context';

export interface AvailabilityWindow {
  id: string;
  staffUserId: string;
  staffName: string;
  weekday: number;
  startTime: string;
  endTime: string;
  timeZone: string;
  kinds: string[];
  active: boolean;
}

/** staff_availability rows with names (read-only; there is no write endpoint yet). */
export async function listAvailabilityWindows(
  identity: RequestIdentity,
): Promise<AvailabilityWindow[]> {
  requireAnyStaff(identity, ['appointments.manage_all']);
  return staffTx(identity, async (tx) => {
    const rows = await tx
      .select({ a: schema.staffAvailability, name: schema.user.name })
      .from(schema.staffAvailability)
      .innerJoin(schema.user, eq(schema.user.id, schema.staffAvailability.staffUserId))
      .orderBy(
        asc(schema.user.name),
        asc(schema.staffAvailability.weekday),
        asc(schema.staffAvailability.startTime),
      );
    return rows.map((r) => ({
      id: r.a.id,
      staffUserId: r.a.staffUserId,
      staffName: r.name,
      weekday: r.a.weekday,
      startTime: String(r.a.startTime),
      endTime: String(r.a.endTime),
      timeZone: r.a.timeZone,
      kinds: Array.isArray(r.a.kinds) ? (r.a.kinds as string[]) : [],
      active: Boolean(r.a.active),
    }));
  });
}

export interface StaffAppointmentsView {
  items: AppointmentDto[];
  nextCursor: string | null;
  calendar: CalendarStatusDto | null;
  staff: Array<{ userId: string; name: string }>;
  permissions: { manageAll: boolean; testBooking: boolean; integrations: boolean };
}

export async function staffAppointments(
  identity: RequestIdentity,
  query: AppointmentListQuery,
): Promise<StaffAppointmentsView> {
  requireAnyStaff(identity, ['appointments.manage_all']);
  const viewer = viewerFromIdentity(identity);
  const [page, staff, calendar] = await Promise.all([
    listAppointments(viewer, query),
    listStaffAssignees(identity),
    getCalendarStatus(identity).catch(() => null),
  ]);
  return {
    items: page.items,
    nextCursor: page.nextCursor,
    calendar,
    staff: staff.map((s) => ({ userId: s.userId, name: s.name })),
    permissions: {
      manageAll: can(identity, 'appointments.manage_all'),
      testBooking: can(identity, 'appointments.test_booking'),
      integrations: can(identity, 'integrations.read'),
    },
  };
}
