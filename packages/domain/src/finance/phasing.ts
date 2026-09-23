import type { Result } from './result';
import { fail, InputCheck, isPresent, ok } from './result';

/** A calendar month. `month` is 1–12. */
export interface YearMonth {
  year: number;
  month: number;
}

/** Adds (or, when negative, subtracts) whole months. */
export function addMonths(start: YearMonth, months: number): YearMonth {
  const index = start.year * 12 + (start.month - 1) + months;
  return { year: Math.floor(index / 12), month: (((index % 12) + 12) % 12) + 1 };
}

function checkYearMonth(check: InputCheck, name: string, value: unknown): YearMonth | null {
  if (!isPresent(value) || typeof value !== 'object') {
    check.absent(name);
    return null;
  }
  const candidate = value as { year?: unknown; month?: unknown };
  const year = check.integer(`${name}.year`, candidate.year, 0);
  const month = check.integer(`${name}.month`, candidate.month, 1);
  if (Number.isFinite(month) && month > 12) check.problem(`${name}.month must be between 1 and 12`);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month > 12) return null;
  return { year, month };
}

export interface CompletionPlan {
  constructionStart: YearMonth;
  /** Whole months of construction from `constructionStart`. 0 means already built. */
  constructionDurationMonths: number;
}

export interface CompletionSchedule {
  constructionStart: YearMonth;
  constructionDurationMonths: number;
  /** First month in which letting could begin with no delay: the month after construction ends. */
  plannedCompletion: YearMonth;
  /** Months after `constructionStart` at which rent would start with no delay (= duration). */
  plannedRentalStartIndex: number;
  /** Scenario assumption, whole months. */
  completionDelayMonths: number;
  /** First month in which rental income starts once the delay is applied. */
  rentalStart: YearMonth;
  /** Months after `constructionStart` at which rental income starts (= duration + delay). */
  rentalStartIndex: number;
}

/**
 * Brief §6.4: "completion delays postpone rental start". Given a construction
 * plan and an explicit delay assumption, returns when rent actually begins.
 */
export function applyCompletionDelay(
  plan: CompletionPlan | null | undefined,
  completionDelayMonths: number | null | undefined,
): Result<CompletionSchedule> {
  if (!isPresent(plan)) {
    return fail('A construction plan is required.', [
      'constructionStart',
      'constructionDurationMonths',
    ]);
  }
  const check = new InputCheck();
  const start = checkYearMonth(check, 'constructionStart', plan.constructionStart);
  const duration = check.integer('constructionDurationMonths', plan.constructionDurationMonths, 0);
  const delay = check.integer('completionDelayMonths', completionDelayMonths, 0);
  if (check.failed || start === null) return check.failure();
  return ok({
    constructionStart: start,
    constructionDurationMonths: duration,
    plannedCompletion: addMonths(start, duration),
    plannedRentalStartIndex: duration,
    completionDelayMonths: delay,
    rentalStart: addMonths(start, duration + delay),
    rentalStartIndex: duration + delay,
  });
}

/**
 * Linear occupancy ramp after rental start: the first operating month runs at
 * `startingOccupancyFraction`, rising in equal steps to full occupancy at
 * `months` months after rental start.
 */
export interface StabilisationRamp {
  months: number;
  startingOccupancyFraction: number;
}

/** Construction cost to phase; only a straight-line profile is offered. */
export interface ConstructionSpend {
  total: number;
  profile: 'straight_line';
}

export interface PhasingInput extends CompletionPlan {
  completionDelayMonths: number;
  stabilisationRamp?: StabilisationRamp | null;
  /** Annual rental income at stabilised occupancy (e.g. long-let effective income), whole naira. */
  annualRentalIncome: number;
  /** Annual recurring operating expenses once operating, whole naira. */
  annualOperatingExpenses: number;
  constructionSpend?: ConstructionSpend | null;
  /** Number of months to produce, counted from `constructionStart`. */
  horizonMonths: number;
}

export type CashFlowPhase = 'construction' | 'delay' | 'ramp_up' | 'stabilised';

export interface MonthlyCashFlow {
  /** 0-based months after `constructionStart`. */
  index: number;
  year: number;
  month: number;
  phase: CashFlowPhase;
  /** 0 before rental start, ramping to 1 once stabilised. */
  occupancyFraction: number;
  constructionSpend: number;
  rentalIncome: number;
  operatingExpenses: number;
  /** `rentalIncome - operatingExpenses - constructionSpend`. */
  netCashFlow: number;
  cumulativeNetCashFlow: number;
}

export interface MonthlyPhasing {
  schedule: CompletionSchedule;
  /** Months after `constructionStart` from which occupancy is 1. */
  stabilisationIndex: number;
  months: MonthlyCashFlow[];
  totals: {
    constructionSpend: number;
    rentalIncome: number;
    operatingExpenses: number;
    netCashFlow: number;
  };
}

/**
 * Monthly cash-flow phasing. Rental income and operating expenses start only
 * at `completion + delay`; construction spend (when given) is spread evenly
 * over the construction months; income then ramps if a ramp is supplied.
 */
export function monthlyPhasing(input: PhasingInput | null | undefined): Result<MonthlyPhasing> {
  if (!isPresent(input)) return fail('Phasing inputs are required.', ['phasing']);
  const check = new InputCheck();
  const schedule = applyCompletionDelay(input, input.completionDelayMonths);
  check.absorb(schedule);
  const annualRent = check.amount('annualRentalIncome', input.annualRentalIncome);
  const annualOpex = check.amount('annualOperatingExpenses', input.annualOperatingExpenses);
  const horizon = check.integer('horizonMonths', input.horizonMonths, 1);

  let rampMonths = 0;
  let rampStart = 1;
  if (isPresent(input.stabilisationRamp)) {
    rampMonths = check.integer('stabilisationRamp.months', input.stabilisationRamp.months, 0);
    rampStart = check.fraction(
      'stabilisationRamp.startingOccupancyFraction',
      input.stabilisationRamp.startingOccupancyFraction,
    );
  }

  let spendTotal = 0;
  if (isPresent(input.constructionSpend)) {
    spendTotal = check.amount('constructionSpend.total', input.constructionSpend.total);
    if (input.constructionSpend.profile !== 'straight_line') {
      check.problem("constructionSpend.profile must be 'straight_line'");
    }
    if (schedule.ok && schedule.value.constructionDurationMonths === 0 && spendTotal > 0) {
      check.problem(
        'constructionSpend needs constructionDurationMonths of at least 1 to spread over',
      );
    }
  }
  if (check.failed || !schedule.ok) return check.failure();

  const {
    constructionDurationMonths: duration,
    rentalStartIndex,
    constructionStart,
  } = schedule.value;
  const stabilisationIndex = rentalStartIndex + rampMonths;
  const monthlyRent = annualRent / 12;
  const monthlyOpex = annualOpex / 12;
  const spendPerMonth = duration > 0 ? spendTotal / duration : 0;

  const months: MonthlyCashFlow[] = [];
  const totals = { constructionSpend: 0, rentalIncome: 0, operatingExpenses: 0, netCashFlow: 0 };
  let cumulative = 0;
  for (let index = 0; index < horizon; index += 1) {
    let phase: CashFlowPhase;
    let occupancy = 0;
    if (index < duration) {
      phase = 'construction';
    } else if (index < rentalStartIndex) {
      phase = 'delay';
    } else if (index < stabilisationIndex) {
      phase = 'ramp_up';
      occupancy = rampStart + ((1 - rampStart) * (index - rentalStartIndex)) / rampMonths;
    } else {
      phase = 'stabilised';
      occupancy = 1;
    }
    const constructionSpend = index < duration ? spendPerMonth : 0;
    const operating = index >= rentalStartIndex;
    const rentalIncome = operating ? monthlyRent * occupancy : 0;
    const operatingExpenses = operating ? monthlyOpex : 0;
    const netCashFlow = rentalIncome - operatingExpenses - constructionSpend;
    cumulative += netCashFlow;
    const calendar = addMonths(constructionStart, index);
    months.push({
      index,
      year: calendar.year,
      month: calendar.month,
      phase,
      occupancyFraction: occupancy,
      constructionSpend,
      rentalIncome,
      operatingExpenses,
      netCashFlow,
      cumulativeNetCashFlow: cumulative,
    });
    totals.constructionSpend += constructionSpend;
    totals.rentalIncome += rentalIncome;
    totals.operatingExpenses += operatingExpenses;
    totals.netCashFlow += netCashFlow;
  }

  return ok({ schedule: schedule.value, stabilisationIndex, months, totals });
}
