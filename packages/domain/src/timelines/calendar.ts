import { DateTime } from 'luxon';

/**
 * Shared working-day calendar helpers for the timeline engines.
 *
 * Dates are ISO calendar dates (`YYYY-MM-DD`). Internally a date is a "day
 * number" (whole days since 1970-01-01, UTC) so that calendar arithmetic is
 * plain integer arithmetic that never depends on the host time zone or the
 * wall clock. Nothing in this module reads the current time.
 */

/** A working calendar: which weekdays and which dates are non-working. */
export interface WorkingCalendar {
  /** ISO weekday numbers (1 = Monday … 7 = Sunday) that are non-working days. */
  weekend: number[];
  /** Non-working dates (public holidays, site shutdowns) as ISO calendar dates. */
  holidays: string[];
}

/** Compiled form of a {@link WorkingCalendar} for fast membership tests. */
export interface CompiledCalendar {
  weekend: ReadonlySet<number>;
  holidays: ReadonlySet<number>;
  source: WorkingCalendar;
}

/**
 * Saturday and Sunday as non-working days. This is a named convention, not a
 * hidden default: a function that falls back to it must echo that fact in
 * its output so the reader knows which calendar produced the number.
 */
export const SATURDAY_SUNDAY_WEEKEND: readonly number[] = Object.freeze([6, 7]);

export const MS_PER_DAY = 86_400_000;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written as `YYYY-MM-DD` (2026-02-30 is rejected). */
export function isValidIsoDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_DATE_RE.test(value) &&
    DateTime.fromISO(value, { zone: 'utc' }).isValid
  );
}

/** Whole days since 1970-01-01 for an ISO calendar date. Throws on invalid input. */
export function dayNumber(isoDate: string): number {
  if (!isValidIsoDate(isoDate)) {
    throw new RangeError(`Invalid ISO calendar date: ${String(isoDate)}`);
  }
  return Math.round(DateTime.fromISO(isoDate, { zone: 'utc' }).toMillis() / MS_PER_DAY);
}

/** The ISO calendar date for a day number (inverse of {@link dayNumber}). */
export function isoDateFromDayNumber(day: number): string {
  const iso = DateTime.fromMillis(day * MS_PER_DAY, { zone: 'utc' }).toISODate();
  if (iso === null) throw new RangeError(`Day number out of range: ${day}`);
  return iso;
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a day number. */
export function isoWeekdayOf(day: number): number {
  // Day 0 (1970-01-01) was a Thursday, ISO weekday 4. The double modulo keeps
  // negative day numbers (dates before 1970) correct.
  return ((((day + 3) % 7) + 7) % 7) + 1;
}

/** Calendar days from `startIso` to `endIso` (positive when `endIso` is later). */
export function daysBetween(startIso: string, endIso: string): number {
  return dayNumber(endIso) - dayNumber(startIso);
}

/** Returns a list of problems with a calendar; empty when it is usable. */
export function validateWorkingCalendar(calendar: WorkingCalendar): string[] {
  const problems: string[] = [];
  if (!Array.isArray(calendar.weekend)) {
    problems.push('weekend must be an array of ISO weekday numbers');
  } else {
    for (const w of calendar.weekend) {
      if (!Number.isInteger(w) || w < 1 || w > 7) {
        problems.push(`weekend day ${String(w)} is not an ISO weekday number (1-7)`);
      }
    }
    if (new Set(calendar.weekend).size >= 7) {
      problems.push('every weekday is marked as weekend; no working day exists');
    }
  }
  if (!Array.isArray(calendar.holidays)) {
    problems.push('holidays must be an array of ISO calendar dates');
  } else {
    for (const h of calendar.holidays) {
      if (!isValidIsoDate(h)) problems.push(`holiday ${String(h)} is not an ISO calendar date`);
    }
  }
  return problems;
}

/** Compiles a calendar for repeated lookups. Throws when the calendar is invalid. */
export function compileCalendar(calendar: WorkingCalendar): CompiledCalendar {
  const problems = validateWorkingCalendar(calendar);
  if (problems.length > 0) throw new RangeError(problems.join('; '));
  return {
    weekend: new Set(calendar.weekend),
    holidays: new Set(calendar.holidays.map(dayNumber)),
    source: calendar,
  };
}

export function isWorkingDayNumber(day: number, calendar: CompiledCalendar): boolean {
  return !calendar.weekend.has(isoWeekdayOf(day)) && !calendar.holidays.has(day);
}

/** The first working day on or after `day`. */
export function snapForwardToWorkingDay(day: number, calendar: CompiledCalendar): number {
  let d = day;
  while (!isWorkingDayNumber(d, calendar)) d += 1;
  return d;
}

/**
 * Consumes `n` working days starting at the first working day on or after the
 * boundary `day` and returns the boundary *after* the last consumed day (the
 * day number of the day following the last working day). With `n === 0` the
 * boundary is returned unchanged; a negative `n` moves backwards.
 */
export function advanceWorkingDays(day: number, n: number, calendar: CompiledCalendar): number {
  if (n === 0) return day;
  if (n < 0) return retreatWorkingDays(day, -n, calendar);
  let d = snapForwardToWorkingDay(day, calendar);
  let remaining = n;
  for (;;) {
    if (isWorkingDayNumber(d, calendar)) {
      remaining -= 1;
      if (remaining === 0) return d + 1;
    }
    d += 1;
  }
}

/**
 * Steps back `n` working days from the boundary `day` and returns the day
 * number of the earliest of those working days, i.e. the latest start from
 * which `n` working days fit before `day`. Inverse of {@link advanceWorkingDays}
 * in the sense that `advanceWorkingDays(retreatWorkingDays(x, n), n) <= x`.
 */
export function retreatWorkingDays(day: number, n: number, calendar: CompiledCalendar): number {
  if (n === 0) return day;
  if (n < 0) return advanceWorkingDays(day, -n, calendar);
  let d = day;
  let counted = 0;
  while (counted < n) {
    d -= 1;
    if (isWorkingDayNumber(d, calendar)) counted += 1;
  }
  return d;
}

/** Working days in the half-open range `[fromDay, toDayExclusive)`; negative when reversed. */
export function countWorkingDaysBetween(
  fromDay: number,
  toDayExclusive: number,
  calendar: CompiledCalendar,
): number {
  if (toDayExclusive < fromDay) return -countWorkingDaysBetween(toDayExclusive, fromDay, calendar);
  let count = 0;
  for (let d = fromDay; d < toDayExclusive; d += 1) {
    if (isWorkingDayNumber(d, calendar)) count += 1;
  }
  return count;
}

/** True when the ISO date is a working day in the calendar. */
export function isWorkingDay(isoDate: string, calendar: WorkingCalendar): boolean {
  return isWorkingDayNumber(dayNumber(isoDate), compileCalendar(calendar));
}

/**
 * Business days elapsed from `startIso` (inclusive) to `endIsoExclusive`
 * (exclusive): Monday to the following Monday with a Saturday/Sunday weekend
 * is 5 business days.
 */
export function countBusinessDays(
  startIso: string,
  endIsoExclusive: string,
  calendar: WorkingCalendar,
): number {
  return countWorkingDaysBetween(
    dayNumber(startIso),
    dayNumber(endIsoExclusive),
    compileCalendar(calendar),
  );
}
