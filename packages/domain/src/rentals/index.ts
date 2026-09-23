import { bpsOf, type Kobo } from '../money';

/**
 * Property management arithmetic with no I/O: rent schedule generation with
 * documented proration, arrears ageing, owner statement maths, maintenance
 * SLA clocks, asset service recurrence and short-stay calendar rules.
 *
 * Money is integer kobo (bigint). Dates are calendar dates (`YYYY-MM-DD`);
 * a period runs from `periodStart` to `periodEnd` inclusive. Nothing here
 * invents a rate: proration only ever scales the agreed rent by elapsed days
 * over the days of the full period it belongs to, and academic-period leases
 * take their terms verbatim from the lease.
 */

/* -------------------------------------------------------------------------- */
/* Calendar helpers                                                           */
/* -------------------------------------------------------------------------- */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

export function parseDate(value: string): Date {
  if (!DATE_RE.test(value)) throw new RangeError(`invalid calendar date "${value}"`);
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw new RangeError(`invalid calendar date "${value}"`);
  }
  return date;
}

export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(value: string, days: number): string {
  return formatDate(new Date(parseDate(value).getTime() + days * MS_PER_DAY));
}

/** Adds calendar months, clamping the day to the target month's length (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(value: string, months: number): string {
  const d = parseDate(value);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return formatDate(target);
}

/** Inclusive day count between two calendar dates. */
export function daysInclusive(start: string, end: string): number {
  const diff = Math.round((parseDate(end).getTime() - parseDate(start).getTime()) / MS_PER_DAY);
  if (diff < 0) throw new RangeError(`period end ${end} is before start ${start}`);
  return diff + 1;
}

export function compareDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* -------------------------------------------------------------------------- */
/* Rent schedules                                                             */
/* -------------------------------------------------------------------------- */

export type RentPeriod = 'monthly' | 'quarterly' | 'annual' | 'term';

export const MONTHS_PER_PERIOD: Record<Exclude<RentPeriod, 'term'>, number> = {
  monthly: 1,
  quarterly: 3,
  annual: 12,
};

export interface AcademicTerm {
  /** Label such as "2026/2027 First semester". */
  label: string;
  start: string;
  end: string;
  /** Rent for the term. Falls back to the lease rent amount when omitted. */
  amountKobo?: Kobo;
}

export interface ScheduleInput {
  startDate: string;
  /** Inclusive; open-ended leases pass null and receive `horizonPeriods` periods. */
  endDate: string | null;
  rentAmountKobo: Kobo;
  rentPeriod: RentPeriod;
  /** Days before the period start on which the rent falls due (0 = on the first day). */
  dueLeadDays?: number;
  /** Academic terms for `term` leases; ignored otherwise. */
  academicTerms?: AcademicTerm[];
  /** Number of periods generated for an open-ended lease (default 12). */
  horizonPeriods?: number;
  /**
   * Whether a partial first or last period is prorated by days. Nigerian
   * annual tenancies are commonly charged in full for the agreed term; the
   * lease decides. Default true.
   */
  prorate?: boolean;
}

export interface SchedulePeriod {
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  amountKobo: Kobo;
  /** Present when the amount was scaled for a partial period. */
  proration: { days: number; ofDays: number } | null;
  label: string | null;
}

export class ScheduleError extends Error {
  override readonly name = 'ScheduleError';
}

/**
 * Prorates a full-period rent by elapsed days: amount × days ÷ daysInFullPeriod,
 * rounded half up to the nearest kobo. The "full period" is the calendar span
 * the partial period sits in (e.g. the month, quarter or year starting at the
 * lease anniversary), so two half months of different lengths never share a
 * daily rate invented from thin air.
 */
export function prorateByDays(amountKobo: Kobo, days: number, ofDays: number): Kobo {
  if (days <= 0 || ofDays <= 0 || days > ofDays)
    throw new ScheduleError(`cannot prorate ${days} of ${ofDays} days`);
  if (days === ofDays) return amountKobo;
  const numerator = amountKobo * BigInt(days);
  const denominator = BigInt(ofDays);
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

function dueDateFor(periodStart: string, leadDays: number): string {
  return addDays(periodStart, -leadDays);
}

/**
 * Generates the rent periods of a lease. Periods start on the lease start
 * date and repeat every 1/3/12 months. When the lease ends inside a period,
 * the last period is truncated and (by default) prorated by days over the
 * full period it would have covered. A lease is never charged beyond its
 * end date and never charged for a zero-day period.
 */
export function generateRentSchedule(input: ScheduleInput): SchedulePeriod[] {
  if (input.rentAmountKobo < 0n) throw new ScheduleError('rent amount cannot be negative');
  const leadDays = input.dueLeadDays ?? 0;
  if (!Number.isInteger(leadDays) || leadDays < 0 || leadDays > 365)
    throw new ScheduleError('dueLeadDays must be an integer between 0 and 365');
  parseDate(input.startDate);
  if (input.endDate !== null) {
    if (compareDates(input.endDate, input.startDate) < 0)
      throw new ScheduleError('lease end date is before its start date');
  }

  if (input.rentPeriod === 'term') {
    const terms = input.academicTerms ?? [];
    if (terms.length === 0)
      throw new ScheduleError('academic-period leases need at least one term');
    const sorted = [...terms].sort((a, b) => compareDates(a.start, b.start));
    const out: SchedulePeriod[] = [];
    let previousEnd: string | null = null;
    for (const term of sorted) {
      if (daysInclusive(term.start, term.end) < 1) throw new ScheduleError('empty term');
      if (previousEnd && compareDates(term.start, previousEnd) <= 0)
        throw new ScheduleError(`academic terms overlap at ${term.start}`);
      if (compareDates(term.start, input.startDate) < 0)
        throw new ScheduleError(`term ${term.label} starts before the lease`);
      if (input.endDate && compareDates(term.end, input.endDate) > 0)
        throw new ScheduleError(`term ${term.label} ends after the lease`);
      out.push({
        periodStart: term.start,
        periodEnd: term.end,
        dueDate: dueDateFor(term.start, leadDays),
        amountKobo: term.amountKobo ?? input.rentAmountKobo,
        proration: null,
        label: term.label,
      });
      previousEnd = term.end;
    }
    return out;
  }

  const months = MONTHS_PER_PERIOD[input.rentPeriod];
  const prorate = input.prorate ?? true;
  const horizon = input.horizonPeriods ?? 12;
  const out: SchedulePeriod[] = [];
  let cursor = input.startDate;
  let index = 0;
  while (true) {
    const fullEnd = addDays(addMonths(cursor, months), -1);
    if (input.endDate === null && index >= horizon) break;
    if (input.endDate !== null && compareDates(cursor, input.endDate) > 0) break;
    const truncated = input.endDate !== null && compareDates(fullEnd, input.endDate) > 0;
    const periodEnd = truncated ? input.endDate! : fullEnd;
    const ofDays = daysInclusive(cursor, fullEnd);
    const days = daysInclusive(cursor, periodEnd);
    const partial = truncated && days < ofDays;
    out.push({
      periodStart: cursor,
      periodEnd,
      dueDate: dueDateFor(cursor, leadDays),
      amountKobo:
        partial && prorate
          ? prorateByDays(input.rentAmountKobo, days, ofDays)
          : input.rentAmountKobo,
      proration: partial && prorate ? { days, ofDays } : null,
      label: null,
    });
    if (truncated) break;
    cursor = addDays(fullEnd, 1);
    index += 1;
  }
  return out;
}

/** Periods whose due date falls on or before `asOf + leadDays` and are not yet invoiced. */
export function periodsDueForInvoicing<T extends { dueDate: string; status: string }>(
  periods: T[],
  asOf: string,
  leadDays: number,
): T[] {
  const cutoff = addDays(asOf, leadDays);
  return periods.filter((p) => p.status === 'scheduled' && compareDates(p.dueDate, cutoff) <= 0);
}

/**
 * A charge for a period that ends early (termination inside the period):
 * scaled by the days kept over the days of the period as scheduled, half-up.
 * `newEnd` must fall inside the period and before its scheduled end.
 */
export function truncateCharge(
  amountKobo: Kobo,
  periodStart: string,
  periodEnd: string,
  newEnd: string,
): Kobo {
  if (compareDates(newEnd, periodStart) < 0 || compareDates(newEnd, periodEnd) >= 0)
    throw new ScheduleError(`${newEnd} does not cut the period ${periodStart}..${periodEnd}`);
  return prorateByDays(
    amountKobo,
    daysInclusive(periodStart, newEnd),
    daysInclusive(periodStart, periodEnd),
  );
}

/* -------------------------------------------------------------------------- */
/* Lease lifecycle                                                            */
/* -------------------------------------------------------------------------- */

/** Days before the end date a lease turns `expiring` when the lease sets no notice period. */
export const DEFAULT_EXPIRY_NOTICE_DAYS = 30;

/**
 * The system transition due for a lease on `asOf` (`leaseMachine` system
 * rules): `active → expiring` inside the notice window before the end date,
 * `active | expiring → ended` once the end date has passed. Open-ended,
 * draft and closed leases never move on their own.
 */
export function leaseLifecycleTarget(
  lease: { status: string; endDate: string | null; noticePeriodDays?: number | null },
  asOf: string,
): 'expiring' | 'ended' | null {
  if (!lease.endDate) return null;
  if (lease.status !== 'active' && lease.status !== 'expiring') return null;
  if (compareDates(asOf, lease.endDate) > 0) return 'ended';
  if (lease.status === 'active') {
    const notice = lease.noticePeriodDays ?? DEFAULT_EXPIRY_NOTICE_DAYS;
    if (compareDates(asOf, addDays(lease.endDate, -notice)) >= 0) return 'expiring';
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Collections                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Apportions one settled allocation across the charges of its invoice in the
 * order given (oldest first), never above what each charge still owes. Any
 * remainder (an overpayment) is left unapportioned.
 */
export function apportionAllocation(
  amountKobo: Kobo,
  charges: ReadonlyArray<{ id: string; amountKobo: Kobo }>,
  paidByCharge: ReadonlyMap<string, Kobo>,
): Array<{ chargeId: string; amountKobo: Kobo }> {
  const out: Array<{ chargeId: string; amountKobo: Kobo }> = [];
  let remaining = amountKobo;
  for (const c of charges) {
    if (remaining <= 0n) break;
    const open = c.amountKobo - (paidByCharge.get(c.id) ?? 0n);
    if (open <= 0n) continue;
    const take = open < remaining ? open : remaining;
    out.push({ chargeId: c.id, amountKobo: take });
    remaining -= take;
  }
  return out;
}

export type RentScheduleStatus =
  'scheduled' | 'invoiced' | 'partially_paid' | 'paid' | 'overdue' | 'waived';

/**
 * Status of an invoiced period from what its charges total and what has been
 * settled against them: paid in full, else overdue once the due date has
 * passed, else partially paid or invoiced. Scheduled and waived periods keep
 * their status.
 */
export function scheduleStatusFor(
  current: RentScheduleStatus,
  totalKobo: Kobo,
  settledKobo: Kobo,
  dueDate: string,
  asOf: string,
): RentScheduleStatus {
  if (current === 'scheduled' || current === 'waived') return current;
  if (settledKobo >= totalKobo) return 'paid';
  if (compareDates(dueDate, asOf) < 0) return 'overdue';
  return settledKobo > 0n ? 'partially_paid' : 'invoiced';
}

/** Whole days a due date is overdue on `asOf` (0 when not yet due). */
export function daysOverdue(dueDate: string, asOf: string): number {
  return compareDates(asOf, dueDate) <= 0 ? 0 : daysInclusive(dueDate, asOf) - 1;
}

/* -------------------------------------------------------------------------- */
/* Balances and arrears                                                       */
/* -------------------------------------------------------------------------- */

export interface ChargeLike {
  id: string;
  amountKobo: Kobo;
  chargedAt: string;
  /** Date from which the charge counts as overdue (the schedule due date, else chargedAt). */
  dueDate?: string | null;
}

export interface AllocationLike {
  rentChargeId: string;
  amountKobo: Kobo;
}

export type ArrearsBucket = 'current' | 'days_1_30' | 'days_31_60' | 'days_61_90' | 'days_over_90';

export const ARREARS_BUCKETS: readonly ArrearsBucket[] = [
  'current',
  'days_1_30',
  'days_31_60',
  'days_61_90',
  'days_over_90',
];

export interface ArrearsAgeing {
  asOf: string;
  buckets: Record<ArrearsBucket, Kobo>;
  totalOutstandingKobo: Kobo;
  /** Outstanding charges with their bucket, oldest first. */
  items: Array<{
    chargeId: string;
    outstandingKobo: Kobo;
    daysOverdue: number;
    bucket: ArrearsBucket;
  }>;
}

export function outstandingByCharge(
  charges: ChargeLike[],
  allocations: AllocationLike[],
): Map<string, Kobo> {
  const paid = new Map<string, Kobo>();
  for (const a of allocations)
    paid.set(a.rentChargeId, (paid.get(a.rentChargeId) ?? 0n) + a.amountKobo);
  const out = new Map<string, Kobo>();
  for (const c of charges) {
    const remaining = c.amountKobo - (paid.get(c.id) ?? 0n);
    out.set(c.id, remaining > 0n ? remaining : 0n);
  }
  return out;
}

export function bucketForDaysOverdue(days: number): ArrearsBucket {
  if (days <= 0) return 'current';
  if (days <= 30) return 'days_1_30';
  if (days <= 60) return 'days_31_60';
  if (days <= 90) return 'days_61_90';
  return 'days_over_90';
}

/** Ages every outstanding charge by days past its due date as of `asOf`. Charges due in the future are `current`. */
export function ageArrears(
  charges: ChargeLike[],
  allocations: AllocationLike[],
  asOf: string,
): ArrearsAgeing {
  const outstanding = outstandingByCharge(charges, allocations);
  const buckets: Record<ArrearsBucket, Kobo> = {
    current: 0n,
    days_1_30: 0n,
    days_31_60: 0n,
    days_61_90: 0n,
    days_over_90: 0n,
  };
  const items: ArrearsAgeing['items'] = [];
  let total = 0n;
  for (const c of [...charges].sort((a, b) => compareDates(a.chargedAt, b.chargedAt))) {
    const remaining = outstanding.get(c.id) ?? 0n;
    if (remaining <= 0n) continue;
    const overdueDays = daysOverdue(c.dueDate ?? c.chargedAt, asOf);
    const bucket = bucketForDaysOverdue(overdueDays);
    buckets[bucket] += remaining;
    total += remaining;
    items.push({
      chargeId: c.id,
      outstandingKobo: remaining,
      daysOverdue: overdueDays,
      bucket,
    });
  }
  return { asOf, buckets, totalOutstandingKobo: total, items };
}

/* -------------------------------------------------------------------------- */
/* Owner statements                                                           */
/* -------------------------------------------------------------------------- */

export type StatementLineKind =
  | 'rent_collected'
  | 'service_charge_collected'
  | 'management_fee'
  | 'maintenance_recovery'
  | 'short_stay_income'
  | 'short_stay_expense'
  | 'arrears';

export interface StatementLine {
  kind: StatementLineKind;
  description: string;
  amountKobo: Kobo;
  leaseId?: string | null;
  workOrderId?: string | null;
  allocationId?: string | null;
  invoiceId?: string | null;
  stayBookingId?: string | null;
  feeBps?: number | null;
}

export interface StatementTotals {
  collectedKobo: Kobo;
  feesKobo: Kobo;
  expensesKobo: Kobo;
  netKobo: Kobo;
  arrearsKobo: Kobo;
}

/**
 * Collected rent and service charges are liabilities to the owner; the
 * management fee and recoverable maintenance are deducted; the remainder is
 * the net payable. Arrears are reported but never netted. Short-stay lines
 * are informational (they do not flow through invoices) and stay out of the
 * reconciled totals.
 */
export function computeStatementTotals(lines: StatementLine[]): StatementTotals {
  let collected = 0n;
  let fees = 0n;
  let expenses = 0n;
  let arrears = 0n;
  for (const l of lines) {
    switch (l.kind) {
      case 'rent_collected':
      case 'service_charge_collected':
        collected += l.amountKobo;
        break;
      case 'management_fee':
        fees += l.amountKobo;
        break;
      case 'maintenance_recovery':
        expenses += l.amountKobo;
        break;
      case 'arrears':
        arrears += l.amountKobo;
        break;
      default:
        break;
    }
  }
  return {
    collectedKobo: collected,
    feesKobo: fees,
    expensesKobo: expenses,
    netKobo: collected - fees - expenses,
    arrearsKobo: arrears,
  };
}

export interface FeeTerms {
  basis: 'percentage_of_collected' | 'fixed_monthly' | 'none';
  feeBps?: number | null;
  fixedKobo?: Kobo | null;
}

/** Management fee for one lease over a period. Percentage fees use half-up rounding via `bpsOf`. */
export function leaseManagementFee(
  terms: FeeTerms,
  collectedKobo: Kobo,
  monthsInPeriod: number,
): Kobo {
  switch (terms.basis) {
    case 'percentage_of_collected':
      return collectedKobo > 0n && terms.feeBps ? bpsOf(collectedKobo, terms.feeBps) : 0n;
    case 'fixed_monthly':
      return (terms.fixedKobo ?? 0n) * BigInt(Math.max(0, monthsInPeriod));
    case 'none':
      return 0n;
  }
}

/** Whole months spanned by a statement period (1 for any period shorter than a month). */
export function monthsInPeriod(periodStart: string, periodEnd: string): number {
  const s = parseDate(periodStart);
  const e = parseDate(periodEnd);
  const months =
    (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth()) + 1;
  return Math.max(1, months);
}

/* -------------------------------------------------------------------------- */
/* Maintenance SLA                                                            */
/* -------------------------------------------------------------------------- */

export type WorkOrderPriority = 'low' | 'normal' | 'high' | 'urgent';

/** Hours to first response/resolution per priority. Editable by `sla.manage` later; these are the defaults. */
export const DEFAULT_SLA_HOURS: Record<WorkOrderPriority, number> = {
  urgent: 4,
  high: 24,
  normal: 72,
  low: 168,
};

export function slaDueAt(
  priority: WorkOrderPriority,
  from: Date,
  policy: Record<WorkOrderPriority, number> = DEFAULT_SLA_HOURS,
): Date {
  return new Date(from.getTime() + policy[priority] * 3_600_000);
}

export const OPEN_WORK_ORDER_STATUSES = new Set([
  'requested',
  'triaged',
  'assigned',
  'in_progress',
  'awaiting_approval',
  'approved',
]);

/** Breached when still open past the SLA deadline. Completed, verified and closed work stops the clock. */
export function isSlaBreached(status: string, slaDueAt: Date | null, now: Date): boolean {
  if (!slaDueAt) return false;
  if (!OPEN_WORK_ORDER_STATUSES.has(status)) return false;
  return now.getTime() > slaDueAt.getTime();
}

/* -------------------------------------------------------------------------- */
/* Assets and recurrence                                                      */
/* -------------------------------------------------------------------------- */

/** Next service date after a service performed on `servicedOn`; null when the asset has no interval. */
export function nextServiceDate(servicedOn: string, intervalDays: number | null): string | null {
  if (!intervalDays || intervalDays <= 0) return null;
  return addDays(servicedOn, intervalDays);
}

export function warrantyStatus(expiresAt: string, asOf: string): 'active' | 'expiring' | 'expired' {
  if (compareDates(expiresAt, asOf) < 0) return 'expired';
  return daysInclusive(asOf, expiresAt) <= 30 ? 'expiring' : 'active';
}

/* -------------------------------------------------------------------------- */
/* Short stay                                                                 */
/* -------------------------------------------------------------------------- */

/** Nights between check-in and check-out (check-out day is not a night). */
export function nightsBetween(checkIn: string, checkOut: string): number {
  const nights = daysInclusive(checkIn, checkOut) - 1;
  if (nights < 1) throw new ScheduleError('a stay needs at least one night');
  return nights;
}

/** Two stays overlap when one starts before the other ends; same-day turnover (out = in) is allowed. */
export function staysOverlap(
  a: { checkIn: string; checkOut: string },
  b: { checkIn: string; checkOut: string },
): boolean {
  return compareDates(a.checkIn, b.checkOut) < 0 && compareDates(b.checkIn, a.checkOut) < 0;
}

export function stayGross(nights: number, nightlyRateKobo: Kobo): Kobo {
  return BigInt(nights) * nightlyRateKobo;
}
