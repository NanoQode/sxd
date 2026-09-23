/**
 * Deterministic ISO 8601 date handling for the ranking engine.
 *
 * The engine never reads a clock: every freshness decision compares dates the caller supplied with
 * the `asOf` date the caller supplied. A date-only string is UTC midnight; a date-time without an
 * offset is read as UTC, so the outcome never depends on the machine's time zone.
 */

const ISO_DATE_RE =
  /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)(Z|[+-]\d{2}:\d{2})?)?$/;

export const MS_PER_DAY = 86_400_000;

export interface ParsedIsoDate {
  /** Milliseconds since the Unix epoch, UTC. */
  ms: number;
  /** True when the string carried no time component. */
  dateOnly: boolean;
}

/** Parses an ISO 8601 date or date-time; returns null for anything else (never throws). */
export function parseIsoDate(value: string | null | undefined): ParsedIsoDate | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const match = ISO_DATE_RE.exec(text);
  if (!match) return null;
  const hasTime = match[2] !== undefined;
  const hasZone = match[3] !== undefined;
  const ms = Date.parse(hasTime && !hasZone ? `${text}Z` : text);
  if (!Number.isFinite(ms)) return null;
  return { ms, dateOnly: !hasTime };
}

/** Whole days from `fromMs` to `toMs` (negative when `toMs` is earlier). */
export function daysBetween(fromMs: number, toMs: number): number {
  return Math.floor((toMs - fromMs) / MS_PER_DAY);
}

/** True when `asOfMs` is after the validity end. A date-only validity covers its whole day. */
export function isExpired(validUntil: ParsedIsoDate, asOfMs: number): boolean {
  const end = validUntil.dateOnly ? validUntil.ms + MS_PER_DAY - 1 : validUntil.ms;
  return asOfMs > end;
}
