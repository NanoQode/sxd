import { DateTime } from 'luxon';
import type { WorkingCalendar } from './calendar';
import {
  MS_PER_DAY,
  SATURDAY_SUNDAY_WEEKEND,
  compileCalendar,
  countWorkingDaysBetween,
  dayNumber,
  validateWorkingCalendar,
} from './calendar';

/**
 * Approvals (permit) timeline (system C of the timelines specification).
 *
 * Specification, quoted:
 *
 * > Records: jurisdiction, authority, permit/document type, completeness
 * > date, application reference, fees, queries, resubmissions, decision.
 * > `durationDays({ startedAt, endedAt, basis: 'elapsed'|'business',
 * > calendar? })` where business days skip weekends/holidays; the basis is
 * > mandatory and echoed.
 * >
 * > `summarizeObservedDurations(observations)` grouping by (jurisdiction,
 * > authority, permitType, dayBasis): count, median, p25, p75, min, max.
 * > Return an empty summary (not a default) when there are no observations:
 * > "Do not impose a fabricated national 'permit in X weeks' default."
 * >
 * > `statutoryVsObserved({ statutoryTargetDays, statutoryBasis, observed
 * > summary })` returns both figures separately labelled, never blended.
 * >
 * > `permitElapsed({ events: [{ type, occurredAt }], asOf })` computing time
 * > in applicant's court vs authority's court from event sequence
 * > (submitted → authority; query_raised → applicant; resubmitted →
 * > authority; decision ends), with both totals.
 *
 * Timestamps are ISO calendar dates (`2026-09-01`) or ISO date-times. A
 * date-only value is taken as midnight UTC; a date-time keeps its own offset
 * when it has one and is otherwise read as UTC, so results never depend on
 * the host time zone.
 */

export type DayBasis = 'elapsed' | 'business';

export type PermitDecisionOutcome = 'approved' | 'rejected' | 'withdrawn';

export interface PermitQuery {
  raisedAt: string;
  respondedAt?: string | null;
  summary?: string;
}

export interface PermitResubmission {
  submittedAt: string;
  note?: string;
}

export interface PermitDecision {
  outcome: PermitDecisionOutcome;
  decidedAt: string;
  reference?: string | null;
  note?: string;
}

export interface PermitFees {
  amountKobo: number;
  paidAt?: string | null;
  receiptReference?: string | null;
}

export interface StatutoryTarget {
  days: number;
  basis: DayBasis;
  sourceNote?: string;
}

/** One permit or document application as tracked by the approvals timeline. */
export interface PermitRecord {
  jurisdiction: string;
  authority: string;
  permitType: string;
  documentType?: string | null;
  /** Date the application was judged complete by the authority. */
  completenessDate?: string | null;
  applicationReference?: string | null;
  fees?: PermitFees | null;
  queries: PermitQuery[];
  resubmissions: PermitResubmission[];
  decision?: PermitDecision | null;
  statutoryTarget?: StatutoryTarget | null;
}

/* -------------------------------------------------------------------------- */
/* Durations                                                                  */
/* -------------------------------------------------------------------------- */

export interface DurationDaysInput {
  startedAt: string;
  endedAt: string;
  /** Mandatory. Elapsed counts every day; business skips weekends and holidays. */
  basis: DayBasis;
  /** Used for the business basis. When omitted, Saturday/Sunday with no holidays is used and echoed. */
  calendar?: WorkingCalendar;
}

export type DurationDaysResult =
  | { ok: true; basis: 'elapsed'; days: number; startedAt: string; endedAt: string }
  | {
      ok: true;
      basis: 'business';
      days: number;
      startedAt: string;
      endedAt: string;
      calendar: WorkingCalendar;
      calendarSource: 'provided' | 'saturday_sunday_convention';
    }
  | {
      ok: false;
      error: {
        code: 'invalid_basis' | 'invalid_date' | 'invalid_range' | 'invalid_calendar';
        message: string;
      };
    };

/**
 * Days from `startedAt` to `endedAt` on the stated basis. Business days are
 * counted in the half-open range [startedAt, endedAt): Monday to the next
 * Monday is 5 business days and 7 elapsed days.
 */
export function durationDays(input: DurationDaysInput): DurationDaysResult {
  const { startedAt, endedAt, basis } = input;
  if (basis !== 'elapsed' && basis !== 'business') {
    return fail('invalid_basis', "basis must be 'elapsed' or 'business'");
  }
  const start = toInstant(startedAt);
  const end = toInstant(endedAt);
  if (!start || !end)
    return fail('invalid_date', 'startedAt and endedAt must be ISO dates or date-times');
  if (end < start) return fail('invalid_range', 'endedAt must not be before startedAt');

  if (basis === 'elapsed') {
    return { ok: true, basis, days: elapsedDays(start, end), startedAt, endedAt };
  }
  const calendar: WorkingCalendar = input.calendar ?? {
    weekend: [...SATURDAY_SUNDAY_WEEKEND],
    holidays: [],
  };
  const problems = validateWorkingCalendar(calendar);
  if (problems.length > 0) return fail('invalid_calendar', problems.join('; '));
  return {
    ok: true,
    basis,
    days: businessDays(start, end, calendar),
    startedAt,
    endedAt,
    calendar,
    calendarSource: input.calendar ? 'provided' : 'saturday_sunday_convention',
  };
}

function fail(
  code: 'invalid_basis' | 'invalid_date' | 'invalid_range' | 'invalid_calendar',
  message: string,
): DurationDaysResult {
  return { ok: false, error: { code, message } };
}

/** Parses an ISO date or date-time deterministically (see module notes). */
function toInstant(value: unknown): DateTime | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const dt = DateTime.fromISO(value, { zone: 'utc', setZone: true });
  return dt.isValid ? dt : null;
}

function elapsedDays(start: DateTime, end: DateTime): number {
  return (end.toMillis() - start.toMillis()) / MS_PER_DAY;
}

function businessDays(start: DateTime, end: DateTime, calendar: WorkingCalendar): number {
  return countWorkingDaysBetween(
    dayNumber(isoDateOf(start)),
    dayNumber(isoDateOf(end)),
    compileCalendar(calendar),
  );
}

function isoDateOf(dt: DateTime): string {
  const iso = dt.toISODate();
  if (iso === null) throw new RangeError('Invalid DateTime');
  return iso;
}

/* -------------------------------------------------------------------------- */
/* Observed durations                                                         */
/* -------------------------------------------------------------------------- */

export interface DurationObservation {
  durationDays: number;
  dayBasis: DayBasis;
  permitType: string;
  authority: string;
  jurisdiction: string;
}

export interface ObservedDurationGroup {
  jurisdiction: string;
  authority: string;
  permitType: string;
  dayBasis: DayBasis;
  count: number;
  min: number;
  max: number;
  median: number;
  p25: number;
  p75: number;
}

export interface ObservedDurationSummary {
  groups: ObservedDurationGroup[];
  totalObservations: number;
  /** Observations dropped because their duration or basis was unusable. */
  ignored: number;
}

/**
 * Groups observations by (jurisdiction, authority, permitType, dayBasis) and
 * reports count, min, max, median, p25 and p75 per group. Percentiles use
 * linear interpolation between order statistics. With no observations the
 * summary is empty (`groups: []`): "Do not impose a fabricated national
 * 'permit in X weeks' default."
 */
export function summarizeObservedDurations(
  observations: DurationObservation[],
): ObservedDurationSummary {
  const buckets = new Map<string, { meta: DurationObservation; values: number[] }>();
  let ignored = 0;
  for (const o of observations) {
    if (
      !Number.isFinite(o.durationDays) ||
      o.durationDays < 0 ||
      (o.dayBasis !== 'elapsed' && o.dayBasis !== 'business')
    ) {
      ignored += 1;
      continue;
    }
    const key = [o.jurisdiction, o.authority, o.permitType, o.dayBasis].join('\u0000');
    const bucket = buckets.get(key);
    if (bucket) bucket.values.push(o.durationDays);
    else buckets.set(key, { meta: o, values: [o.durationDays] });
  }

  const groups: ObservedDurationGroup[] = [];
  let total = 0;
  for (const { meta, values } of buckets.values()) {
    const sorted = [...values].sort((a, b) => a - b);
    total += sorted.length;
    groups.push({
      jurisdiction: meta.jurisdiction,
      authority: meta.authority,
      permitType: meta.permitType,
      dayBasis: meta.dayBasis,
      count: sorted.length,
      min: sorted[0] as number,
      max: sorted[sorted.length - 1] as number,
      median: percentile(sorted, 0.5),
      p25: percentile(sorted, 0.25),
      p75: percentile(sorted, 0.75),
    });
  }
  return { groups, totalObservations: total, ignored };
}

/** Linear interpolation between order statistics (R type 7); `sorted` must be non-empty. */
function percentile(sorted: number[], p: number): number {
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const loValue = sorted[lo] as number;
  const hiValue = sorted[hi] as number;
  return loValue + (hiValue - loValue) * (rank - lo);
}

/* -------------------------------------------------------------------------- */
/* Statutory vs observed                                                      */
/* -------------------------------------------------------------------------- */

export interface StatutoryVsObservedInput {
  statutoryTargetDays: number | null;
  statutoryBasis: DayBasis | null;
  /** The observed group for the same jurisdiction/authority/permit type, or null when none exists. */
  observed: ObservedDurationGroup | null;
}

export interface StatutoryVsObserved {
  statutory: { label: 'statutory_target'; days: number; basis: DayBasis } | null;
  observed: {
    label: 'observed';
    count: number;
    median: number;
    p25: number;
    p75: number;
    min: number;
    max: number;
    basis: DayBasis;
  } | null;
  /** True when both figures exist on the same day basis; null when either is missing. */
  sameBasis: boolean | null;
  note: string;
}

/**
 * Places the statutory target and the observed figures side by side, each
 * under its own label and basis. Nothing is averaged or blended: a statutory
 * promise and an observed record are different facts.
 */
export function statutoryVsObserved(input: StatutoryVsObservedInput): StatutoryVsObserved {
  const statutory =
    input.statutoryTargetDays !== null &&
    Number.isFinite(input.statutoryTargetDays) &&
    input.statutoryBasis !== null
      ? {
          label: 'statutory_target' as const,
          days: input.statutoryTargetDays,
          basis: input.statutoryBasis,
        }
      : null;
  const observed = input.observed
    ? {
        label: 'observed' as const,
        count: input.observed.count,
        median: input.observed.median,
        p25: input.observed.p25,
        p75: input.observed.p75,
        min: input.observed.min,
        max: input.observed.max,
        basis: input.observed.dayBasis,
      }
    : null;
  const sameBasis = statutory && observed ? statutory.basis === observed.basis : null;
  let note: string;
  if (!statutory && !observed)
    note = 'No statutory target and no observed durations are available.';
  else if (!observed)
    note = 'No observed durations; the statutory target is not evidence of actual processing time.';
  else if (!statutory) note = 'No statutory target recorded; observed durations only.';
  else if (sameBasis)
    note =
      'Statutory target and observed durations share a day basis and may be read side by side; they are not blended.';
  else
    note = `Statutory target is in ${statutory.basis} days and observed durations in ${observed.basis} days; compare with care, they are not blended.`;
  return { statutory, observed, sameBasis, note };
}

/* -------------------------------------------------------------------------- */
/* Elapsed time by court                                                      */
/* -------------------------------------------------------------------------- */

export type PermitEventType =
  'submitted' | 'query_raised' | 'resubmitted' | 'decision' | 'approved' | 'rejected' | 'withdrawn';

export interface PermitEvent {
  type: PermitEventType;
  occurredAt: string;
}

export type PermitCourt = 'applicant' | 'authority';

export interface PermitElapsedSegment {
  court: PermitCourt;
  from: string;
  to: string;
  days: number;
  closedBy: PermitEventType | 'as_of';
}

export interface PermitElapsedInput {
  events: PermitEvent[];
  /** Instant up to which open time is counted (server time, passed in). */
  asOf: string;
  /** Defaults to elapsed and is echoed. */
  basis?: DayBasis;
  /** For the business basis; Saturday/Sunday with no holidays when omitted. */
  calendar?: WorkingCalendar;
}

export interface PermitElapsed {
  basis: DayBasis;
  asOf: string;
  applicantDays: number;
  authorityDays: number;
  totalDays: number;
  status: 'not_submitted' | 'with_authority' | 'with_applicant' | 'decided';
  segments: PermitElapsedSegment[];
  /** Events that could not be applied in sequence (e.g. a query before submission) or that fall after `asOf`. */
  ignoredEvents: Array<{ event: PermitEvent; reason: string }>;
}

const DECISION_EVENTS: ReadonlySet<PermitEventType> = new Set([
  'decision',
  'approved',
  'rejected',
  'withdrawn',
]);

/**
 * Splits the life of an application into whose court it was in:
 * submitted → authority; query_raised → applicant; resubmitted → authority;
 * a decision ends the clock. Time still open at `asOf` is counted up to
 * `asOf`. Both totals are reported; neither is a forecast.
 */
export function permitElapsed(input: PermitElapsedInput): PermitElapsed {
  const basis: DayBasis = input.basis ?? 'elapsed';
  const calendar: WorkingCalendar = input.calendar ?? {
    weekend: [...SATURDAY_SUNDAY_WEEKEND],
    holidays: [],
  };
  const asOf = toInstant(input.asOf);
  if (!asOf)
    throw new RangeError(`asOf must be an ISO date or date-time, got ${String(input.asOf)}`);
  const measure = (from: DateTime, to: DateTime): number =>
    basis === 'business' ? businessDays(from, to, calendar) : elapsedDays(from, to);

  const ignoredEvents: Array<{ event: PermitEvent; reason: string }> = [];
  const parsed: Array<{ event: PermitEvent; at: DateTime }> = [];
  for (const event of input.events) {
    const at = toInstant(event.occurredAt);
    if (!at) {
      ignoredEvents.push({ event, reason: 'invalid_timestamp' });
    } else if (at > asOf) {
      ignoredEvents.push({ event, reason: 'after_as_of' });
    } else {
      parsed.push({ event, at });
    }
  }
  parsed.sort((a, b) => a.at.toMillis() - b.at.toMillis());

  const segments: PermitElapsedSegment[] = [];
  let status: PermitElapsed['status'] = 'not_submitted';
  let open: { court: PermitCourt; from: DateTime } | null = null;

  const close = (to: DateTime, closedBy: PermitEventType | 'as_of') => {
    if (!open) return;
    segments.push({
      court: open.court,
      from: open.from.toISO() as string,
      to: to.toISO() as string,
      days: measure(open.from, to),
      closedBy,
    });
    open = null;
  };

  for (const { event, at } of parsed) {
    const { type } = event;
    if (status === 'decided') {
      ignoredEvents.push({ event, reason: 'after_decision' });
    } else if (type === 'submitted' && status === 'not_submitted') {
      open = { court: 'authority', from: at };
      status = 'with_authority';
    } else if (type === 'query_raised' && status === 'with_authority') {
      close(at, type);
      open = { court: 'applicant', from: at };
      status = 'with_applicant';
    } else if (type === 'resubmitted' && status === 'with_applicant') {
      close(at, type);
      open = { court: 'authority', from: at };
      status = 'with_authority';
    } else if (DECISION_EVENTS.has(type) && status !== 'not_submitted') {
      close(at, type);
      status = 'decided';
    } else {
      ignoredEvents.push({ event, reason: `unexpected_${type}_while_${status}` });
    }
  }
  close(asOf, 'as_of');

  const sum = (court: PermitCourt) =>
    segments.filter((s) => s.court === court).reduce((acc, s) => acc + s.days, 0);
  const applicantDays = sum('applicant');
  const authorityDays = sum('authority');
  return {
    basis,
    asOf: asOf.toISO() as string,
    applicantDays,
    authorityDays,
    totalDays: applicantDays + authorityDays,
    status,
    segments,
    ignoredEvents,
  };
}
