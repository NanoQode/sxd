import { DateTime } from 'luxon';

/**
 * Presentation helpers shared by portal server and client components. Money
 * arrives as integer kobo strings; every conversion here is display only.
 */

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Kobo string to naira with sign, e.g. "-₦12,500.00". Never floating-point arithmetic on money. */
export function koboToNaira(
  kobo: string | null | undefined,
  options: { whole?: boolean } = {},
): string {
  if (kobo === null || kobo === undefined || kobo === '') return '—';
  const negative = kobo.startsWith('-');
  const digits = negative ? kobo.slice(1) : kobo;
  if (!/^\d+$/.test(digits)) return kobo;
  const padded = digits.padStart(3, '0');
  const whole = padded.slice(0, -2);
  const fraction = padded.slice(-2);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}₦${grouped}${options.whole ? '' : `.${fraction}`}`;
}

export function isPositiveKobo(kobo: string | null | undefined): boolean {
  return Boolean(kobo && /^\d+$/.test(kobo) && BigInt(kobo) > 0n);
}

/** Wall-clock label in a zone with the zone's abbreviation, DST safe via IANA rules. */
export function formatInZone(
  iso: string | Date,
  zone: string,
  format = "EEE d LLL yyyy, HH:mm 'ZZZZ'",
): string {
  const dt =
    typeof iso === 'string' ? DateTime.fromISO(iso, { setZone: true }) : DateTime.fromJSDate(iso);
  const zoned = dt.setZone(zone);
  if (!zoned.isValid) return typeof iso === 'string' ? iso : iso.toISOString();
  return zoned.toFormat(format.replace("'ZZZZ'", 'ZZZZ'));
}

export function formatDateInZone(iso: string | Date, zone: string): string {
  return formatInZone(iso, zone, 'EEE d LLL yyyy');
}

export function formatTimeInZone(iso: string | Date, zone: string): string {
  return formatInZone(iso, zone, 'HH:mm ZZZZ');
}

/** ISO calendar date (YYYY-MM-DD) in a zone, for grouping slots by the customer's day. */
export function localDateKey(iso: string, zone: string): string {
  const dt = DateTime.fromISO(iso, { setZone: true }).setZone(zone);
  return dt.toISODate() ?? iso.slice(0, 10);
}

export function isValidTimeZone(zone: string): boolean {
  return DateTime.now().setZone(zone).isValid;
}

/** Best-effort browser zone; falls back to the business zone when unavailable. */
export function browserTimeZone(fallback = 'Africa/Lagos'): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && isValidTimeZone(zone) ? zone : fallback;
  } catch {
    return fallback;
  }
}

export function relativeTime(iso: string, now: Date = new Date()): string {
  const dt = DateTime.fromISO(iso);
  if (!dt.isValid) return iso;
  return dt.toRelative({ base: DateTime.fromJSDate(now) }) ?? iso;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
