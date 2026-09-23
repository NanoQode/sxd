import { DateTime, type DateTimeFormatOptions } from 'luxon';

/**
 * Time helpers. Storage is UTC; display uses Africa/Lagos for the business
 * plus the customer's chosen zone. Explicit formats such as "22 Sep 2026".
 */

export const BUSINESS_TIME_ZONE = 'Africa/Lagos';

export function isValidTimeZone(zone: string): boolean {
  return DateTime.now().setZone(zone).isValid;
}

export function formatDate(date: Date | string, zone: string = BUSINESS_TIME_ZONE): string {
  return toDateTime(date, zone).toFormat('d LLL yyyy');
}

export function formatDateTime(date: Date | string, zone: string = BUSINESS_TIME_ZONE): string {
  return toDateTime(date, zone).toFormat('d LLL yyyy, HH:mm');
}

export function formatTime(date: Date | string, zone: string = BUSINESS_TIME_ZONE): string {
  return toDateTime(date, zone).toFormat('HH:mm');
}

export function zoneAbbreviation(date: Date | string, zone: string): string {
  return toDateTime(date, zone).toFormat('ZZZZ');
}

/** "22 Sep 2026, 14:00 (WAT) · 09:00 (EDT) in America/Toronto" */
export function dualZoneDisplay(
  date: Date | string,
  customerZone: string,
  businessZone: string = BUSINESS_TIME_ZONE,
): { business: string; customer: string; sameZone: boolean } {
  const business = `${formatDateTime(date, businessZone)} (${zoneAbbreviation(date, businessZone)})`;
  const customer = `${formatDateTime(date, customerZone)} (${zoneAbbreviation(date, customerZone)}) ${customerZone}`;
  return { business, customer, sameZone: customerZone === businessZone };
}

export function toDateTime(date: Date | string, zone: string): DateTime {
  const dt =
    typeof date === 'string'
      ? DateTime.fromISO(date, { setZone: true })
      : DateTime.fromJSDate(date);
  return dt.setZone(zone);
}

export function toUtcIso(date: Date | string): string {
  return toDateTime(date, 'utc').toISO() ?? new Date(date).toISOString();
}

/** Interprets a wall-clock time in a zone (DST-aware) and returns UTC. */
export function zonedToUtc(isoDate: string, time: string, zone: string): Date {
  const dt = DateTime.fromISO(`${isoDate}T${time}`, { zone });
  if (!dt.isValid) throw new Error(`invalid date/time ${isoDate} ${time} in ${zone}`);
  return dt.toUTC().toJSDate();
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function relativeLabel(date: Date | string, now: Date = new Date()): string {
  const target = toDateTime(date, 'utc');
  const rel = target.toRelative({ base: DateTime.fromJSDate(now) });
  return rel ?? formatDate(date);
}

export const dateFormatOptions: DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
};
