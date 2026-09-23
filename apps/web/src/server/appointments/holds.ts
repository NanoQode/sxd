import { randomBytes } from 'node:crypto';
import { and, lt, eq, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { ApiError, type AppointmentKind, type HoldCreate, type HoldDto } from '@simplexd/contracts';
import { getDb, schema, systemContext, withActor, type DbExecutor } from '@simplexd/db';
import { dualZoneLabel } from '@simplexd/integrations/google';
import type { RequestIdentity } from '@/lib/auth/session';
import { pickStaff, staffAvailableFor, type ProviderBusyLoader } from './availability';
import { durationForKind, isGuestBookable } from './settings';

/**
 * Expiring booking holds. A hold is a `slot_reservations` row of kind `hold`
 * with an expiry and an opaque token; the EXCLUDE constraint
 * (`slot_reservations_no_overlap`) rejects any overlapping reservation for
 * the same staff member, so two customers racing for one slot can never both
 * hold it. The loser receives `slot_unavailable`.
 */

export const HOLD_NOTE_PREFIX = 'kind=';

export function newHoldToken(): string {
  return randomBytes(24).toString('base64url');
}

/** PostgreSQL SQLSTATE for exclusion-constraint violations. */
export const EXCLUSION_VIOLATION = '23P01';

export function isExclusionViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (code === EXCLUSION_VIOLATION) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function kindFromHoldNote(note: string | null): AppointmentKind | null {
  if (!note || !note.startsWith(HOLD_NOTE_PREFIX)) return null;
  return note.slice(HOLD_NOTE_PREFIX.length) as AppointmentKind;
}

export async function purgeExpiredHolds(tx: DbExecutor, now: Date): Promise<number> {
  const rows = await tx
    .delete(schema.slotReservations)
    .where(
      and(eq(schema.slotReservations.kind, 'hold'), lt(schema.slotReservations.expiresAt, now)),
    )
    .returning({ id: schema.slotReservations.id });
  return rows.length;
}

export interface CreateHoldOptions {
  identity: RequestIdentity | null;
  now?: Date;
  providerBusy?: ProviderBusyLoader;
}

export async function createHold(input: HoldCreate, options: CreateHoldOptions): Promise<HoldDto> {
  const now = options.now ?? new Date();
  if (!DateTime.now().setZone(input.customerTimeZone).isValid) {
    throw new ApiError('validation_failed', `unknown time zone: ${input.customerTimeZone}`);
  }
  const start = DateTime.fromISO(input.start, { setZone: true });
  if (!start.isValid) throw new ApiError('validation_failed', 'start must be an RFC 3339 instant');
  if (start.toMillis() <= now.getTime())
    throw new ApiError('slot_unavailable', 'that time has already passed');

  return withActor(getDb(), systemContext('booking-hold'), async (tx) => {
    // Expired holds still occupy the exclusion index until the scheduler
    // sweeps them; clear them here so a fresh hold can take the slot at once.
    await purgeExpiredHolds(tx, now);

    const probe = await staffAvailableFor(tx, {
      kind: input.kind,
      staffUserId: input.staffUserId,
      slot: { start: start.toUTC().toISO()!, end: start.toUTC().toISO()! },
      now,
    });
    const settings = probe.settings;
    if (!options.identity?.session && !isGuestBookable(settings, input.kind)) {
      throw new ApiError('unauthenticated', 'sign in to book this kind of appointment');
    }
    const duration = durationForKind(settings, input.kind);
    const slot = {
      start: start.toUTC().toISO()!,
      end: start.plus({ minutes: duration }).toUTC().toISO()!,
    };
    const { candidates } = await staffAvailableFor(tx, {
      kind: input.kind,
      staffUserId: input.staffUserId,
      slot,
      now,
      providerBusy: options.providerBusy,
    });
    if (candidates.length === 0) {
      throw new ApiError(
        'slot_unavailable',
        probe.plan.unavailableReason === 'no_staff_configured'
          ? 'no staff availability is configured for this appointment kind yet'
          : 'that slot is no longer available; pick another time',
      );
    }
    const staffUserId = await pickStaff(tx, candidates, slot, settings.routing);
    const holdToken = newHoldToken();
    const expiresAt = new Date(now.getTime() + settings.holdTtlMinutes * 60_000);
    try {
      await tx.insert(schema.slotReservations).values({
        staffUserId,
        slot: sql`tstzrange(${slot.start}::timestamptz, ${slot.end}::timestamptz, '[)')` as unknown as string,
        kind: 'hold',
        expiresAt,
        holdToken,
        note: `${HOLD_NOTE_PREFIX}${input.kind}`,
      });
    } catch (err) {
      if (isExclusionViolation(err)) {
        throw new ApiError(
          'slot_unavailable',
          'someone else just reserved that slot; pick another time',
          { details: { staffUserId, start: slot.start } },
        );
      }
      throw err;
    }
    const businessZone =
      probe.plan.windows.get(staffUserId)?.[0]?.timeZone ?? settings.workingHours.timeZone;
    return {
      holdToken,
      kind: input.kind,
      staffUserId,
      start: slot.start,
      end: slot.end,
      expiresAt: expiresAt.toISOString(),
      label: dualZoneLabel(slot.start, businessZone, input.customerTimeZone, slot.end),
    };
  });
}

export interface LockedHold {
  id: string;
  staffUserId: string;
  kind: AppointmentKind | null;
  start: Date;
  end: Date;
  expiresAt: Date | null;
}

/** Locks a live hold (FOR UPDATE) so two bookings cannot both consume it. */
export async function lockHold(tx: DbExecutor, holdToken: string, now: Date): Promise<LockedHold> {
  const rows = await tx.execute<{
    id: string;
    staff_user_id: string;
    kind: string;
    note: string | null;
    expires_at: Date | null;
    appointment_id: string | null;
    slot_start: string;
    slot_end: string;
  }>(sql`
    SELECT id, staff_user_id, kind, note, expires_at, appointment_id,
           lower(slot)::text AS slot_start, upper(slot)::text AS slot_end
    FROM slot_reservations WHERE hold_token = ${holdToken} FOR UPDATE
  `);
  const row = rows.rows[0];
  if (!row || row.kind !== 'hold' || row.appointment_id) {
    throw new ApiError('slot_unavailable', 'this hold is no longer valid; pick a time again');
  }
  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) {
    throw new ApiError('slot_unavailable', 'this hold has expired; pick a time again', {
      details: { expiredAt: new Date(row.expires_at).toISOString() },
    });
  }
  return {
    id: row.id,
    staffUserId: row.staff_user_id,
    kind: kindFromHoldNote(row.note),
    start: new Date(row.slot_start),
    end: new Date(row.slot_end),
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
  };
}
