import { and, eq, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { ApiError, type AppointmentKind, type AvailabilityResponse } from '@simplexd/contracts';
import {
  getDb,
  pgArrayLiteral,
  schema,
  systemContext,
  withActor,
  type DbExecutor,
} from '@simplexd/db';
import {
  computeSlots,
  dualZoneLabel,
  isSlotAvailable,
  type BusyInterval,
  type Slot,
  type WorkingHours,
} from '@simplexd/integrations/google';
import { durationForKind, loadBookingSettings } from './settings';
import type { BookingSettings } from '@simplexd/contracts';

/**
 * Availability = staff working windows (weekday rows in the staff member's
 * zone) minus platform reservations (unexpired holds, appointments, leave,
 * blocks) minus the organiser's external busy periods when a Google
 * connection is available, with the booking buffer applied on both sides.
 *
 * Wall-clock windows are converted with luxon so a 09:00 Lagos window stays
 * 08:00 UTC all year while a London customer sees it move across DST. Slots
 * are only a proposal: the EXCLUDE constraint on slot_reservations decides
 * races when a hold is taken.
 */

export interface StaffWindow extends WorkingHours {
  staffUserId: string;
}

export interface StaffAvailabilityPlan {
  /** Windows grouped per staff member. */
  windows: Map<string, StaffWindow[]>;
  settings: BookingSettings;
  unavailableReason: 'no_staff_configured' | 'kind_not_bookable' | null;
}

function toHHmm(value: string): string {
  return value.slice(0, 5);
}

/**
 * Loads the working windows for a kind. Falls back to the connected calendar
 * organiser with the global working-hours setting when no staff_availability
 * rows exist yet, so a freshly configured deployment can take bookings.
 */
export async function loadStaffWindows(
  tx: DbExecutor,
  input: { kind: AppointmentKind; staffUserId?: string | undefined },
): Promise<StaffAvailabilityPlan> {
  const settings = await loadBookingSettings(tx);
  const rows = await tx
    .select()
    .from(schema.staffAvailability)
    .where(
      and(
        eq(schema.staffAvailability.active, true),
        input.staffUserId ? eq(schema.staffAvailability.staffUserId, input.staffUserId) : undefined,
      ),
    );
  const windows = new Map<string, StaffWindow[]>();
  for (const row of rows) {
    const kinds = Array.isArray(row.kinds) ? row.kinds : [];
    if (kinds.length > 0 && !kinds.includes(input.kind)) continue;
    if (row.weekday < 1 || row.weekday > 7) continue;
    const list = windows.get(row.staffUserId) ?? [];
    const start = toHHmm(String(row.startTime));
    const end = toHHmm(String(row.endTime));
    if (start >= end) continue;
    const existing = list.find(
      (w) => w.timeZone === row.timeZone && w.start === start && w.end === end,
    );
    if (existing) {
      if (!existing.days.includes(row.weekday)) existing.days.push(row.weekday);
    } else {
      list.push({
        staffUserId: row.staffUserId,
        timeZone: row.timeZone,
        days: [row.weekday],
        start,
        end,
      });
    }
    windows.set(row.staffUserId, list);
  }
  if (windows.size === 0) {
    // Fallback: the connected organiser works the global hours.
    const organisers = await tx
      .select({ organizerUserId: schema.calendarConnections.organizerUserId })
      .from(schema.calendarConnections)
      .where(
        and(
          eq(schema.calendarConnections.status, 'connected'),
          input.staffUserId
            ? eq(schema.calendarConnections.organizerUserId, input.staffUserId)
            : undefined,
        ),
      );
    for (const o of organisers) {
      windows.set(o.organizerUserId, [
        { staffUserId: o.organizerUserId, ...settings.workingHours },
      ]);
    }
  }
  return {
    windows,
    settings,
    unavailableReason: windows.size === 0 ? 'no_staff_configured' : null,
  };
}

/** Platform reservations overlapping the window (holds only while unexpired). */
export async function loadReservationBusy(
  tx: DbExecutor,
  staffUserIds: string[],
  from: Date,
  to: Date,
): Promise<Map<string, BusyInterval[]>> {
  const busy = new Map<string, BusyInterval[]>();
  if (staffUserIds.length === 0) return busy;
  const rows = await tx.execute<{
    staff_user_id: string;
    slot_start: string;
    slot_end: string;
  }>(sql`
    SELECT staff_user_id, lower(slot)::text AS slot_start, upper(slot)::text AS slot_end
    FROM slot_reservations
    WHERE staff_user_id = ANY(${pgArrayLiteral(staffUserIds)}::text[])
      AND slot && tstzrange(${from.toISOString()}::timestamptz, ${to.toISOString()}::timestamptz, '[)')
      AND (kind <> 'hold' OR expires_at IS NULL OR expires_at > now())
  `);
  for (const r of rows.rows) {
    const list = busy.get(r.staff_user_id) ?? [];
    list.push({ start: new Date(r.slot_start), end: new Date(r.slot_end) });
    busy.set(r.staff_user_id, list);
  }
  return busy;
}

export interface ProviderBusyLoader {
  (staffUserIds: string[], from: Date, to: Date): Promise<Map<string, BusyInterval[]>>;
}

export interface ComputeAvailabilityInput {
  kind: AppointmentKind;
  staffUserId?: string | undefined;
  from: Date;
  to: Date;
  customerTimeZone: string;
  now?: Date;
  /** Optional external (Google free/busy) loader; failures are swallowed and reported. */
  providerBusy?: ProviderBusyLoader;
}

function assertZone(zone: string): void {
  if (!DateTime.now().setZone(zone).isValid) {
    throw new ApiError('validation_failed', `unknown time zone: ${zone}`, {
      details: { path: 'tz' },
    });
  }
}

export async function computeAvailability(
  input: ComputeAvailabilityInput,
): Promise<AvailabilityResponse> {
  assertZone(input.customerTimeZone);
  const now = input.now ?? new Date();
  const pad = 24 * 3600_000;
  return withActor(getDb(), systemContext('availability'), async (tx) => {
    const plan = await loadStaffWindows(tx, { kind: input.kind, staffUserId: input.staffUserId });
    const settings = plan.settings;
    const duration = durationForKind(settings, input.kind);
    const staffIds = [...plan.windows.keys()];
    const reservationBusy = await loadReservationBusy(
      tx,
      staffIds,
      new Date(input.from.getTime() - pad),
      new Date(input.to.getTime() + pad),
    );
    let providerBusyIncluded = false;
    let providerBusy = new Map<string, BusyInterval[]>();
    if (input.providerBusy && staffIds.length > 0) {
      try {
        providerBusy = await input.providerBusy(
          staffIds,
          new Date(input.from.getTime() - pad),
          new Date(input.to.getTime() + pad),
        );
        providerBusyIncluded = true;
      } catch {
        providerBusyIncluded = false;
      }
    }
    const slots: AvailabilityResponse['slots'] = [];
    for (const [staffUserId, windows] of plan.windows) {
      const busy = [
        ...(reservationBusy.get(staffUserId) ?? []),
        ...(providerBusy.get(staffUserId) ?? []),
      ];
      const seen = new Set<string>();
      for (const window of windows) {
        const computed = computeSlots({
          workingHours: window,
          holidays: settings.holidays,
          durationMinutes: duration,
          bufferMinutes: settings.bufferMinutes,
          minNoticeHours: settings.minNoticeHours,
          maxDaysAhead: settings.maxDaysAhead,
          from: input.from,
          to: input.to,
          busy,
          now,
        });
        for (const slot of computed) {
          if (seen.has(slot.start)) continue;
          seen.add(slot.start);
          slots.push({
            start: slot.start,
            end: slot.end,
            staffUserId,
            label: dualZoneLabel(slot.start, window.timeZone, input.customerTimeZone, slot.end),
          });
        }
      }
    }
    slots.sort(
      (a, b) => a.start.localeCompare(b.start) || a.staffUserId.localeCompare(b.staffUserId),
    );
    return {
      kind: input.kind,
      durationMinutes: duration,
      bufferMinutes: settings.bufferMinutes,
      minNoticeHours: settings.minNoticeHours,
      maxDaysAhead: settings.maxDaysAhead,
      businessTimeZone: settings.workingHours.timeZone,
      customerTimeZone: input.customerTimeZone,
      providerBusyIncluded,
      unavailableReason: plan.unavailableReason,
      slots,
      generatedAt: now.toISOString(),
    };
  });
}

/**
 * Recheck used before a hold is inserted: the slot must sit inside one of the
 * staff member's windows and clear every busy interval with the buffer.
 * Returns the candidate staff ids that can take the slot.
 */
export async function staffAvailableFor(
  tx: DbExecutor,
  input: {
    kind: AppointmentKind;
    staffUserId?: string | undefined;
    slot: Slot;
    now: Date;
    providerBusy?: ProviderBusyLoader;
  },
): Promise<{ candidates: string[]; settings: BookingSettings; plan: StaffAvailabilityPlan }> {
  const plan = await loadStaffWindows(tx, { kind: input.kind, staffUserId: input.staffUserId });
  const settings = plan.settings;
  const staffIds = [...plan.windows.keys()];
  const pad = 24 * 3600_000;
  const from = new Date(new Date(input.slot.start).getTime() - pad);
  const to = new Date(new Date(input.slot.end).getTime() + pad);
  const reservationBusy = await loadReservationBusy(tx, staffIds, from, to);
  let providerBusy = new Map<string, BusyInterval[]>();
  if (input.providerBusy && staffIds.length > 0) {
    try {
      providerBusy = await input.providerBusy(staffIds, from, to);
    } catch {
      providerBusy = new Map();
    }
  }
  const candidates: string[] = [];
  for (const [staffUserId, windows] of plan.windows) {
    const busy = [
      ...(reservationBusy.get(staffUserId) ?? []),
      ...(providerBusy.get(staffUserId) ?? []),
    ];
    const ok = windows.some((window) =>
      isSlotAvailable(input.slot, {
        workingHours: window,
        holidays: settings.holidays,
        bufferMinutes: settings.bufferMinutes,
        minNoticeHours: settings.minNoticeHours,
        maxDaysAhead: settings.maxDaysAhead,
        busy,
        now: input.now,
      }),
    );
    if (ok) candidates.push(staffUserId);
  }
  return { candidates, settings, plan };
}

/** Round-robin-ish routing: the candidate with the fewest reservations on that day. */
export async function pickStaff(
  tx: DbExecutor,
  candidates: string[],
  slot: Slot,
  routing: BookingSettings['routing'],
): Promise<string> {
  if (candidates.length === 1 || routing === 'first_available') return candidates[0]!;
  const dayStart = DateTime.fromISO(slot.start, { setZone: true }).startOf('day');
  const dayEnd = dayStart.plus({ days: 1 });
  const rows = await tx.execute<{ staff_user_id: string; n: string }>(sql`
    SELECT staff_user_id, count(*)::text AS n FROM slot_reservations
    WHERE staff_user_id = ANY(${pgArrayLiteral(candidates)}::text[])
      AND slot && tstzrange(${dayStart.toISO()}::timestamptz, ${dayEnd.toISO()}::timestamptz, '[)')
      AND (kind <> 'hold' OR expires_at IS NULL OR expires_at > now())
    GROUP BY staff_user_id
  `);
  const counts = new Map(rows.rows.map((r) => [r.staff_user_id, Number(r.n)]));
  return [...candidates].sort(
    (a, b) => (counts.get(a) ?? 0) - (counts.get(b) ?? 0) || a.localeCompare(b),
  )[0]!;
}
