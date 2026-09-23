import { DateTime } from 'luxon';

/**
 * Pure availability computation. Inputs are UTC instants plus the business
 * working hours expressed in the business time zone; output slots are UTC
 * instants. Wall-clock → instant conversion is DST-aware (luxon), so a
 * 09:00–17:00 Lagos day stays 08:00–16:00 UTC all year while a Toronto
 * customer sees it move from 04:00 EDT to 03:00 EST across 1 November 2026.
 *
 * `busy` must already combine Google free/busy, platform slot reservations
 * (holds, appointments, buffers, blocks) and staff leave. This function never
 * claims a distributed atomic guarantee: the database exclusion constraint on
 * slot_reservations decides races, and availability is rechecked before
 * confirmation.
 */

export interface WorkingHours {
  /** IANA zone the hours are expressed in (business zone). */
  timeZone: string;
  /** ISO weekdays: 1 = Monday … 7 = Sunday. */
  days: number[];
  /** "HH:mm" local time. */
  start: string;
  /** "HH:mm" local time (exclusive end). */
  end: string;
}

export interface BusyInterval {
  start: string | Date;
  /** Exclusive. */
  end: string | Date;
}

export interface ComputeSlotsInput {
  workingHours: WorkingHours;
  /** "yyyy-MM-dd" dates in the business zone. */
  holidays?: readonly string[];
  durationMinutes: number;
  /** Minimum gap kept before and after any busy interval (default 0). */
  bufferMinutes?: number;
  /** Earliest bookable start is now + minNoticeHours (default 0). */
  minNoticeHours?: number;
  /** Latest bookable start is now + maxDaysAhead days (default 60). */
  maxDaysAhead?: number;
  /** Requested window (UTC instants). */
  from: string | Date;
  to: string | Date;
  busy: readonly BusyInterval[];
  now: string | Date;
  /** Grid step between candidate starts (default = durationMinutes). */
  stepMinutes?: number;
}

export interface Slot {
  /** UTC ISO instant. */
  start: string;
  /** UTC ISO instant (exclusive). */
  end: string;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function toUtcDateTime(value: string | Date): DateTime {
  const dt =
    typeof value === 'string'
      ? DateTime.fromISO(value, { setZone: true })
      : DateTime.fromJSDate(value);
  if (!dt.isValid) throw new Error(`invalid date/time: ${String(value)}`);
  return dt.toUTC();
}

function maxDate(a: DateTime, b: DateTime): DateTime {
  return a > b ? a : b;
}

function minDate(a: DateTime, b: DateTime): DateTime {
  return a < b ? a : b;
}

export function validateWorkingHours(hours: WorkingHours): void {
  if (!DateTime.now().setZone(hours.timeZone).isValid)
    throw new Error(`unknown time zone: ${hours.timeZone}`);
  if (!TIME_PATTERN.test(hours.start) || !TIME_PATTERN.test(hours.end))
    throw new Error('working hours must be HH:mm');
  if (hours.start >= hours.end) throw new Error('working hours must start before they end');
  if (hours.days.some((d) => !Number.isInteger(d) || d < 1 || d > 7))
    throw new Error('working days must be ISO weekdays 1–7');
}

export function computeSlots(input: ComputeSlotsInput): Slot[] {
  validateWorkingHours(input.workingHours);
  const duration = input.durationMinutes;
  if (!Number.isInteger(duration) || duration <= 0)
    throw new Error('durationMinutes must be a positive integer');
  const step = input.stepMinutes ?? duration;
  if (!Number.isInteger(step) || step <= 0)
    throw new Error('stepMinutes must be a positive integer');
  const bufferMs = (input.bufferMinutes ?? 0) * 60_000;
  const zone = input.workingHours.timeZone;

  const now = toUtcDateTime(input.now);
  const earliest = maxDate(
    toUtcDateTime(input.from),
    now.plus({ hours: input.minNoticeHours ?? 0 }),
  );
  const latestStart = now.plus({ days: input.maxDaysAhead ?? 60 });
  const windowEnd = toUtcDateTime(input.to);
  if (earliest >= windowEnd) return [];

  const busy = input.busy
    .map((b) => {
      const s = toUtcDateTime(b.start).toMillis();
      const e = toUtcDateTime(b.end).toMillis();
      return e > s ? { start: s - bufferMs, end: e + bufferMs } : null;
    })
    .filter((b): b is { start: number; end: number } => b !== null);

  const holidays = new Set(input.holidays ?? []);
  const days = new Set(input.workingHours.days);
  const slots: Slot[] = [];

  let day = earliest.setZone(zone).startOf('day');
  const lastDay = minDate(windowEnd, latestStart).setZone(zone).startOf('day');
  while (day <= lastDay) {
    const date = day.toISODate();
    if (date && days.has(day.weekday) && !holidays.has(date)) {
      // Wall-clock times in the business zone; luxon resolves DST gaps/overlaps.
      const open = DateTime.fromISO(`${date}T${input.workingHours.start}`, { zone });
      const close = DateTime.fromISO(`${date}T${input.workingHours.end}`, { zone });
      if (open.isValid && close.isValid && close > open) {
        let start = open;
        while (start.plus({ minutes: duration }) <= close) {
          const end = start.plus({ minutes: duration });
          const startMs = start.toMillis();
          const endMs = end.toMillis();
          const inWindow =
            start >= earliest && end <= windowEnd && start <= latestStart && start >= now;
          if (inWindow && !busy.some((b) => startMs < b.end && endMs > b.start)) {
            slots.push({ start: start.toUTC().toISO()!, end: end.toUTC().toISO()! });
          }
          start = start.plus({ minutes: step });
        }
      }
    }
    day = day.plus({ days: 1 });
  }
  return slots;
}

/** Whether a proposed slot fits the working hours and busy intervals (recheck before confirming). */
export function isSlotAvailable(
  slot: { start: string | Date; end: string | Date },
  input: Omit<ComputeSlotsInput, 'from' | 'to' | 'durationMinutes' | 'stepMinutes'>,
): boolean {
  const start = toUtcDateTime(slot.start);
  const end = toUtcDateTime(slot.end);
  const minutes = Math.round(end.diff(start, 'minutes').minutes);
  if (minutes <= 0) return false;
  const startIso = start.toISO() ?? '';
  const endIso = end.toISO() ?? '';
  const candidates = computeSlots({
    ...input,
    from: startIso,
    to: endIso,
    durationMinutes: minutes,
    stepMinutes: 1,
  });
  return candidates.some((c) => c.start === startIso && c.end === endIso);
}

export interface DualZoneLabel {
  /** e.g. "Sun 1 Nov 2026, 09:00–09:30 GMT+1 (Africa/Lagos)" */
  business: string;
  /** e.g. "Sun 1 Nov 2026, 03:00–03:30 EST (America/Toronto)" */
  customer: string;
  sameZone: boolean;
  /** True when the customer's local date differs from the business date. */
  dateDiffers: boolean;
  businessOffsetMinutes: number;
  customerOffsetMinutes: number;
}

function formatRange(start: DateTime, end: DateTime | null, zone: string): string {
  const s = start.setZone(zone).setLocale('en-US');
  const datePart = s.toFormat('ccc d LLL yyyy');
  const abbreviation = s.toFormat('ZZZZ');
  if (!end) return `${datePart}, ${s.toFormat('HH:mm')} ${abbreviation} (${zone})`;
  const e = end.setZone(zone).setLocale('en-US');
  const endPart = e.hasSame(s, 'day') ? e.toFormat('HH:mm') : e.toFormat('ccc d LLL, HH:mm');
  return `${datePart}, ${s.toFormat('HH:mm')}–${endPart} ${abbreviation} (${zone})`;
}

/** Business and customer wall-clock labels for one instant/range, DST-aware. */
export function dualZoneLabel(
  start: string | Date,
  businessZone: string,
  customerZone: string,
  end?: string | Date | null,
): DualZoneLabel {
  const s = toUtcDateTime(start);
  const e = end ? toUtcDateTime(end) : null;
  const sb = s.setZone(businessZone);
  const sc = s.setZone(customerZone);
  if (!sb.isValid) throw new Error(`unknown time zone: ${businessZone}`);
  if (!sc.isValid) throw new Error(`unknown time zone: ${customerZone}`);
  return {
    business: formatRange(s, e, businessZone),
    customer: formatRange(s, e, customerZone),
    sameZone: businessZone === customerZone,
    dateDiffers: sb.toISODate() !== sc.toISODate(),
    businessOffsetMinutes: sb.offset,
    customerOffsetMinutes: sc.offset,
  };
}

/** Groups UTC slots by the customer's local calendar date for display. */
export function groupSlotsByLocalDate(
  slots: readonly Slot[],
  zone: string,
): Record<string, Slot[]> {
  const groups: Record<string, Slot[]> = {};
  for (const slot of slots) {
    const date = DateTime.fromISO(slot.start, { setZone: true }).setZone(zone).toISODate();
    if (!date) continue;
    (groups[date] ??= []).push(slot);
  }
  return groups;
}
