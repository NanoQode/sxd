import 'server-only';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import {
  ApiError,
  availabilityReplaceSchema,
  timeOffCreateSchema,
  type StaffAvailabilityDto,
} from '@simplexd/contracts';
import { getDb, schema, systemContext, withActor, type DbExecutor } from '@simplexd/db';
import { hasStaffPermission } from '@simplexd/domain/authz';
import type { z } from 'zod';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';

/**
 * Staff and partner working windows (`staff_availability`) and time off
 * (`slot_reservations` of kind leave/block) that the booking engine subtracts
 * from open slots.
 *
 * Who may edit: the person themselves (any staff role, or a partner holding
 * `partner.availability.manage`) or staff with `appointments.manage_all`.
 * `staff_availability` is writable only by privileged contexts under
 * row-level security, so after the check above a partner's own edit is
 * written under the system context; staff callers write under their own.
 */

type Row = typeof schema.staffAvailability.$inferSelect;

interface Access {
  userId: string;
  privileged: boolean;
}

function access(identity: RequestIdentity, staffUserId: string, write: boolean): Access {
  const userId = identity.session?.user.id;
  if (!userId) throw new ApiError('unauthenticated', 'sign in required');
  const isStaff = identity.actor.staffRoles.length > 0;
  if (hasStaffPermission(identity.actor, 'appointments.manage_all')) {
    return { userId, privileged: true };
  }
  if (staffUserId !== userId) {
    throw new ApiError('forbidden', 'you can only manage your own availability');
  }
  if (isStaff) return { userId, privileged: true };
  if (identity.actor.isPartner) {
    if (!write) return { userId, privileged: false };
    return { userId, privileged: false };
  }
  throw new ApiError('forbidden', 'only staff and partners have working availability');
}

function hhmm(value: unknown): string {
  return String(value).slice(0, 5);
}

async function isBookableUser(tx: DbExecutor, userId: string): Promise<boolean> {
  const [staff] = await tx
    .select({ userId: schema.staffRoles.userId })
    .from(schema.staffRoles)
    .where(eq(schema.staffRoles.userId, userId))
    .limit(1);
  if (staff) return true;
  const [partner] = await tx
    .select({ userId: schema.partnerProfiles.userId })
    .from(schema.partnerProfiles)
    .where(eq(schema.partnerProfiles.userId, userId))
    .limit(1);
  return Boolean(partner);
}

async function load(tx: DbExecutor, staffUserId: string): Promise<StaffAvailabilityDto> {
  const rows: Row[] = await tx
    .select()
    .from(schema.staffAvailability)
    .where(
      and(
        eq(schema.staffAvailability.staffUserId, staffUserId),
        eq(schema.staffAvailability.active, true),
      ),
    )
    .orderBy(schema.staffAvailability.weekday, schema.staffAvailability.startTime);
  const timeOff = await tx.execute<{
    id: string;
    kind: 'leave' | 'block';
    starts_at: Date;
    ends_at: Date;
    note: string | null;
  }>(sql`
    SELECT id, kind, lower(slot) AS starts_at, upper(slot) AS ends_at, note
    FROM slot_reservations
    WHERE staff_user_id = ${staffUserId}
      AND kind IN ('leave', 'block')
      AND upper(slot) > now()
    ORDER BY lower(slot)
  `);
  return {
    staffUserId,
    windows: rows.map((r) => ({
      weekday: r.weekday,
      start: hhmm(r.startTime),
      end: hhmm(r.endTime),
      timeZone: r.timeZone,
      kinds: (Array.isArray(r.kinds) ? r.kinds : []) as StaffAvailabilityDto['windows'][number]['kinds'],
    })),
    timeOff: timeOff.rows.map((t) => ({
      id: t.id,
      kind: t.kind,
      startsAt: new Date(t.starts_at).toISOString(),
      endsAt: new Date(t.ends_at).toISOString(),
      note: t.note,
    })),
  };
}

function contextFor(identity: RequestIdentity, a: Access, correlationId?: string) {
  return a.privileged ? { ...identity.ctx, correlationId } : systemContext(correlationId);
}

export async function getStaffAvailability(
  identity: RequestIdentity,
  staffUserId: string,
): Promise<StaffAvailabilityDto> {
  const a = access(identity, staffUserId, false);
  return withActor(getDb(), contextFor(identity, a), (tx) => load(tx, staffUserId));
}

export async function replaceStaffAvailability(
  identity: RequestIdentity,
  staffUserId: string,
  input: z.input<typeof availabilityReplaceSchema>,
  options: { correlationId?: string } = {},
): Promise<StaffAvailabilityDto> {
  const a = access(identity, staffUserId, true);
  const { windows } = availabilityReplaceSchema.parse(input);
  return withActor(getDb(), contextFor(identity, a, options.correlationId), async (tx) => {
    if (!(await isBookableUser(tx, staffUserId))) {
      throw new ApiError('not_found', 'no staff member or partner with that id');
    }
    const before = await load(tx, staffUserId);
    await tx
      .delete(schema.staffAvailability)
      .where(eq(schema.staffAvailability.staffUserId, staffUserId));
    if (windows.length > 0) {
      await tx.insert(schema.staffAvailability).values(
        windows.map((w) => ({
          staffUserId,
          weekday: w.weekday,
          startTime: `${w.start}:00`,
          endTime: `${w.end}:00`,
          timeZone: w.timeZone,
          kinds: w.kinds,
          active: true,
        })),
      );
    }
    await recordAudit(tx, identity, {
      action: 'staff_availability.replaced',
      entityType: 'staff_availability',
      entityId: staffUserId,
      before: before.windows,
      after: windows,
      correlationId: options.correlationId ?? null,
    });
    return load(tx, staffUserId);
  });
}

export async function addTimeOff(
  identity: RequestIdentity,
  staffUserId: string,
  input: z.input<typeof timeOffCreateSchema>,
  options: { correlationId?: string } = {},
): Promise<StaffAvailabilityDto> {
  const a = access(identity, staffUserId, true);
  const t = timeOffCreateSchema.parse(input);
  return withActor(getDb(), contextFor(identity, a, options.correlationId), async (tx) => {
    if (!(await isBookableUser(tx, staffUserId))) {
      throw new ApiError('not_found', 'no staff member or partner with that id');
    }
    try {
      await tx.execute(sql`SAVEPOINT time_off_insert`);
      await tx.execute(sql`
        INSERT INTO slot_reservations (staff_user_id, slot, kind, note)
        VALUES (${staffUserId}, tstzrange(${t.startsAt}::timestamptz, ${t.endsAt}::timestamptz, '[)'),
                ${t.kind}, ${t.note ?? null})
      `);
      await tx.execute(sql`RELEASE SAVEPOINT time_off_insert`);
    } catch (err) {
      await tx.execute(sql`ROLLBACK TO SAVEPOINT time_off_insert`);
      const code = (err as { cause?: { code?: string }; code?: string }).cause?.code ??
        (err as { code?: string }).code;
      if (code === '23P01') {
        throw new ApiError(
          'slot_unavailable',
          'this period overlaps an existing appointment, hold or time off; move or cancel it first',
        );
      }
      throw err;
    }
    await recordAudit(tx, identity, {
      action: 'staff_availability.time_off_added',
      entityType: 'staff_availability',
      entityId: staffUserId,
      after: t,
      correlationId: options.correlationId ?? null,
    });
    return load(tx, staffUserId);
  });
}

export async function removeTimeOff(
  identity: RequestIdentity,
  staffUserId: string,
  reservationId: string,
  options: { correlationId?: string } = {},
): Promise<StaffAvailabilityDto> {
  const a = access(identity, staffUserId, true);
  return withActor(getDb(), contextFor(identity, a, options.correlationId), async (tx) => {
    const removed = await tx
      .delete(schema.slotReservations)
      .where(
        and(
          eq(schema.slotReservations.id, reservationId),
          eq(schema.slotReservations.staffUserId, staffUserId),
          inArray(schema.slotReservations.kind, ['leave', 'block']),
        ),
      )
      .returning({ id: schema.slotReservations.id });
    if (removed.length === 0) throw new ApiError('not_found', 'time off entry not found');
    await recordAudit(tx, identity, {
      action: 'staff_availability.time_off_removed',
      entityType: 'staff_availability',
      entityId: staffUserId,
      before: { reservationId },
      correlationId: options.correlationId ?? null,
    });
    return load(tx, staffUserId);
  });
}

/** Staff and partners with at least one active window (for staff pickers). */
export async function listConfiguredStaff(identity: RequestIdentity): Promise<string[]> {
  if (!hasStaffPermission(identity.actor, 'appointments.manage_all')) {
    throw new ApiError('forbidden', 'appointments.manage_all is required');
  }
  const rows = await withActor(getDb(), identity.ctx, (tx) =>
    tx
      .selectDistinct({ staffUserId: schema.staffAvailability.staffUserId })
      .from(schema.staffAvailability)
      .where(and(eq(schema.staffAvailability.active, true), gt(schema.staffAvailability.weekday, 0))),
  );
  return rows.map((r) => r.staffUserId);
}
