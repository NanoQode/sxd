import { eq } from 'drizzle-orm';
import { ApiError } from '@simplexd/contracts';
import { schema, type DbExecutor } from '@simplexd/db';
import { authorizeOrg, hasStaffPermission } from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';

/**
 * Who is looking at an appointment. Row-level security already limits what a
 * session can read; these checks add the application rules (staff without
 * `appointments.manage_all` only see appointments they organise, customers
 * need `org.appointments.manage` for organisation appointments they did not
 * book themselves, guests present the manage token).
 */
export type Viewer =
  | { kind: 'staff'; userId: string; manageAll: boolean; identity: RequestIdentity }
  | { kind: 'customer'; userId: string; identity: RequestIdentity }
  | { kind: 'guest'; manageToken: string };

export type AppointmentRow = typeof schema.appointments.$inferSelect;

export function viewerFromIdentity(identity: RequestIdentity): Viewer {
  const userId = identity.session?.user.id;
  if (!userId) throw new ApiError('unauthenticated', 'sign in required');
  if (identity.actor.staffRoles.length > 0) {
    return {
      kind: 'staff',
      userId,
      manageAll: hasStaffPermission(identity.actor, 'appointments.manage_all'),
      identity,
    };
  }
  return { kind: 'customer', userId, identity };
}

export function guestViewer(manageToken: string): Viewer {
  return { kind: 'guest', manageToken };
}

export function canView(viewer: Viewer, row: AppointmentRow): boolean {
  switch (viewer.kind) {
    case 'staff':
      return viewer.manageAll || row.staffUserId === viewer.userId;
    case 'customer': {
      if (row.customerUserId === viewer.userId) return true;
      // Partners/inspectors booked as the organiser see their own visits.
      if (row.staffUserId === viewer.userId) return true;
      if (row.organizationId) {
        const decision = authorizeOrg(viewer.identity.actor, 'org.appointments.manage', {
          type: 'appointment',
          id: row.id,
          organizationId: row.organizationId,
        });
        return decision.allowed;
      }
      return false;
    }
    case 'guest':
      return row.manageToken !== null && row.manageToken === viewer.manageToken;
    default:
      return false;
  }
}

/** Staff acting as the business (not a customer rescheduling their own slot). */
export function isStaffViewer(viewer: Viewer): boolean {
  return viewer.kind === 'staff';
}

export function viewerUserId(viewer: Viewer): string | null {
  return viewer.kind === 'guest' ? null : viewer.userId;
}

export function viewerIdentity(viewer: Viewer): RequestIdentity | null {
  return viewer.kind === 'guest' ? null : viewer.identity;
}

export async function loadAppointment(
  tx: DbExecutor,
  viewer: Viewer,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<AppointmentRow> {
  const query = tx.select().from(schema.appointments).where(eq(schema.appointments.id, id));
  const rows = options.forUpdate ? await query.for('update') : await query;
  const row = rows[0];
  if (!row || !canView(viewer, row)) throw new ApiError('not_found', 'appointment not found');
  return row;
}

export async function loadAppointmentByManageToken(
  tx: DbExecutor,
  manageToken: string,
  options: { forUpdate?: boolean } = {},
): Promise<AppointmentRow> {
  const query = tx
    .select()
    .from(schema.appointments)
    .where(eq(schema.appointments.manageToken, manageToken));
  const rows = options.forUpdate ? await query.for('update') : await query;
  const row = rows[0];
  if (!row) throw new ApiError('not_found', 'appointment not found');
  return row;
}
