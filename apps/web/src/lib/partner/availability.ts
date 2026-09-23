import type { AppointmentKind, AvailabilityWindow } from '@simplexd/contracts';

/**
 * Form model and validation for the availability editor
 * (`PUT /api/v1/appointments/staff/{userId}`). Weekdays are ISO (1 = Monday …
 * 7 = Sunday), times are local wall-clock `HH:mm` in the window's zone, and an
 * empty `kinds` list means the window serves every appointment kind.
 */

export const WEEKDAY_NAMES: Record<number, string> = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
  7: 'Sunday',
};

export const APPOINTMENT_KINDS: AppointmentKind[] = [
  'consultation',
  'viewing',
  'site_visit',
  'virtual_inspection',
  'meeting',
];

export interface WindowForm {
  id: string;
  weekday: number;
  start: string;
  end: string;
  timeZone: string;
  kinds: AppointmentKind[];
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

let seq = 0;
function nextId(): string {
  seq += 1;
  return `w${seq}`;
}

export function windowsToForm(windows: AvailabilityWindow[]): WindowForm[] {
  return [...windows]
    .sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start))
    .map((w) => ({
      id: nextId(),
      weekday: w.weekday,
      start: w.start.slice(0, 5),
      end: w.end.slice(0, 5),
      timeZone: w.timeZone,
      kinds: [...(w.kinds ?? [])],
    }));
}

export function blankWindow(timeZone: string, weekday = 1): WindowForm {
  return { id: nextId(), weekday, start: '09:00', end: '17:00', timeZone, kinds: [] };
}

/** Validates the rows; returns the API payload only when every row is valid. */
export function validateWindows(rows: WindowForm[]): {
  windows: AvailabilityWindow[] | null;
  errors: string[];
} {
  const errors: string[] = [];
  if (rows.length > 50) errors.push('At most 50 windows can be saved.');
  rows.forEach((r, i) => {
    const label = `Window ${i + 1} (${WEEKDAY_NAMES[r.weekday] ?? 'unknown day'})`;
    if (!WEEKDAY_NAMES[r.weekday]) errors.push(`${label}: choose a weekday`);
    if (!HHMM.test(r.start) || !HHMM.test(r.end))
      errors.push(`${label}: times must be HH:mm (24-hour)`);
    else if (r.start >= r.end) errors.push(`${label}: the start must be before the end`);
    if (!r.timeZone.trim()) errors.push(`${label}: choose a time zone`);
  });
  // Overlapping windows on the same day and zone are almost always a typo.
  rows.forEach((a, i) => {
    rows.slice(i + 1).forEach((b, j) => {
      if (
        a.weekday === b.weekday &&
        a.timeZone === b.timeZone &&
        a.start < b.end &&
        b.start < a.end
      ) {
        errors.push(
          `Windows ${i + 1} and ${i + j + 2} overlap on ${WEEKDAY_NAMES[a.weekday] ?? 'the same day'}`,
        );
      }
    });
  });
  if (errors.length > 0) return { windows: null, errors };
  return {
    windows: rows.map((r) => ({
      weekday: r.weekday,
      start: r.start,
      end: r.end,
      timeZone: r.timeZone.trim(),
      kinds: r.kinds,
    })),
    errors,
  };
}

/** `datetime-local` values are device-local; returns ISO UTC or an error. */
export function validateTimeOff(
  startLocal: string,
  endLocal: string,
  now: Date,
): { startsAt: string; endsAt: string } | { error: string } {
  const start = new Date(startLocal);
  const end = new Date(endLocal);
  if (!startLocal || !endLocal || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()))
    return { error: 'Enter both a start and an end.' };
  if (start >= end) return { error: 'The start must be before the end.' };
  if (end <= now) return { error: 'The period is already over.' };
  return { startsAt: start.toISOString(), endsAt: end.toISOString() };
}
