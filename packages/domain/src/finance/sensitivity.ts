import type { LoanTerms } from './loan';
import { annualDebtService } from './loan';
import type { LongLetEconomics, LongLetInput } from './long-let';
import { longLetEconomics } from './long-let';
import type { Result } from './result';
import { fail, InputCheck, isFiniteNumber, isPresent, ok } from './result';

/**
 * Base scenario for a sensitivity grid. The long-let inputs are the scenario
 * itself; the optional parts feed only the dimensions that need them, and a
 * dimension whose inputs are absent reports `ok: false` per cell instead of
 * assuming anything.
 */
export interface SensitivityBase {
  longLet: LongLetInput;
  /**
   * Loan terms; needed for the `interest` dimension. When supplied, the
   * loan's annuity replaces `longLet.annualDebtService` in every cell
   * (including the base) so debt service has one source.
   */
  loan?: LoanTerms | null;
  /**
   * Cost of every month of completion delay (financing during build, site
   * security, holding costs), whole naira; needed for the
   * `completionDelayMonths` dimension. Pass 0 explicitly when there is none.
   */
  delay?: { holdingCostPerMonth: number } | null;
}

/**
 * Brief §6.4: "Support ... sensitivity charts for vacancy, rents, costs,
 * interest and completion delays." Each array lists the values to test.
 */
export interface SensitivityVariations {
  /** Absolute vacancy rates as fractions. */
  vacancy?: readonly number[];
  /** Multipliers on every unit group's annual rent (1 = base, 0.9 = −10%). */
  rents?: readonly number[];
  /** Multipliers on the cost denominator (1 = base, 1.1 = +10%). */
  costs?: readonly number[];
  /** Absolute annual interest rates as fractions; requires `base.loan`. */
  interest?: readonly number[];
  /** Whole months of completion delay; requires `base.delay`. */
  completionDelayMonths?: readonly number[];
}

export type SensitivityVariable = keyof SensitivityVariations;

export interface SensitivityOutcome {
  netYieldPercent: Result<number>;
  grossYieldPercent: Result<number>;
  noi: number;
  annualDebtService: number;
  cashFlowAfterDebt: number;
  cashFlowAfterDebtAfterTax: number;
  cashOnCashPercent: Result<number>;
  denominatorAmount: number;
  /** `completionDelayMonths` cells only: effective rental income not received during the delay. */
  rentDeferredDuringDelay?: number;
  /** The full long-let result for drill-down. */
  economics: LongLetEconomics;
}

export interface SensitivityCell {
  variable: SensitivityVariable;
  value: number;
  outcome: Result<SensitivityOutcome>;
}

export interface SensitivityGrid {
  base: LongLetEconomics;
  debtServiceSource: 'loan' | 'explicit';
  vacancy: SensitivityCell[];
  rents: SensitivityCell[];
  costs: SensitivityCell[];
  interest: SensitivityCell[];
  completionDelayMonths: SensitivityCell[];
}

function outcome(
  input: LongLetInput,
  extra?: { rentDeferredDuringDelay: number },
): Result<SensitivityOutcome> {
  const result = longLetEconomics(input);
  if (!result.ok) return result;
  const economics = result.value;
  const summary: SensitivityOutcome = {
    netYieldPercent: economics.netYieldPercent,
    grossYieldPercent: economics.grossYieldPercent,
    noi: economics.noi,
    annualDebtService: economics.annualDebtService,
    cashFlowAfterDebt: economics.cashFlowAfterDebt,
    cashFlowAfterDebtAfterTax: economics.cashFlowAfterDebtAfterTax,
    cashOnCashPercent: economics.cashOnCashPercent,
    denominatorAmount: economics.denominator.amount,
    economics,
  };
  if (extra) summary.rentDeferredDuringDelay = extra.rentDeferredDuringDelay;
  return ok(summary);
}

function cells(
  variable: SensitivityVariable,
  values: readonly number[] | undefined,
  run: (value: number) => Result<SensitivityOutcome>,
): SensitivityCell[] {
  if (!Array.isArray(values)) return [];
  return values.map((value) => ({
    variable,
    value,
    outcome: isFiniteNumber(value)
      ? run(value)
      : fail(`${variable} variation must be a finite number (got ${String(value)})`),
  }));
}

/**
 * Runs the long-let model once per variation of one variable at a time,
 * holding everything else at the base. Returns net yield and cash flow for
 * every cell; invalid or unsupported cells fail individually so a chart can
 * still draw the rest.
 */
export function sensitivityGrid(
  base: SensitivityBase | null | undefined,
  variations: SensitivityVariations | null | undefined,
): Result<SensitivityGrid> {
  if (!isPresent(base) || !isPresent(base.longLet)) {
    return fail('A base long-let scenario is required.', ['base.longLet']);
  }
  let baseInput = base.longLet;
  let debtServiceSource: SensitivityGrid['debtServiceSource'] = 'explicit';
  const loan = base.loan ?? null;
  if (loan !== null) {
    const debt = annualDebtService(loan);
    if (!debt.ok) return debt;
    baseInput = { ...baseInput, annualDebtService: debt.value.annualDebtService };
    debtServiceSource = 'loan';
  }
  const baseResult = longLetEconomics(baseInput);
  if (!baseResult.ok) return baseResult;
  const baseEconomics = baseResult.value;
  const requested = variations ?? {};

  const vacancy = cells('vacancy', requested.vacancy, (rate) =>
    rate >= 0 && rate <= 1
      ? outcome({ ...baseInput, vacancyRate: rate })
      : fail('vacancy variation must be a fraction between 0 and 1'),
  );

  const rents = cells('rents', requested.rents, (multiplier) =>
    multiplier >= 0
      ? outcome({
          ...baseInput,
          unitGroups: baseInput.unitGroups.map((group) => ({
            ...group,
            annualRentPerUnit: group.annualRentPerUnit * multiplier,
          })),
        })
      : fail('rents variation must be a multiplier of zero or more'),
  );

  const costs = cells('costs', requested.costs, (multiplier) =>
    multiplier >= 0
      ? outcome({
          ...baseInput,
          denominator: {
            ...baseInput.denominator,
            amount: baseInput.denominator.amount * multiplier,
          },
        })
      : fail('costs variation must be a multiplier of zero or more'),
  );

  const interest = cells('interest', requested.interest, (rate) => {
    if (loan === null) {
      return fail('Interest sensitivity requires loan terms (principal, term, repayment type).', [
        'base.loan',
      ]);
    }
    const debt = annualDebtService({ ...loan, annualInterestRate: rate });
    if (!debt.ok) return debt;
    return outcome({ ...baseInput, annualDebtService: debt.value.annualDebtService });
  });

  const completionDelayMonths = cells(
    'completionDelayMonths',
    requested.completionDelayMonths,
    (months) => {
      const check = new InputCheck();
      const holding = check.amount(
        'base.delay.holdingCostPerMonth',
        base.delay?.holdingCostPerMonth,
      );
      check.integer('completionDelayMonths', months, 0);
      if (check.failed) return check.failure();
      return outcome(
        {
          ...baseInput,
          denominator: {
            ...baseInput.denominator,
            amount: baseInput.denominator.amount + holding * months,
          },
        },
        { rentDeferredDuringDelay: (baseEconomics.effectiveRentalIncome * months) / 12 },
      );
    },
  );

  return ok({
    base: baseEconomics,
    debtServiceSource,
    vacancy,
    rents,
    costs,
    interest,
    completionDelayMonths,
  });
}

/**
 * Low/base/high input sets. `low` and `high` are shallow overrides applied on
 * top of `base` (a complete input set is also accepted); each set is run
 * independently so one invalid set does not hide the others.
 */
export interface ScenarioSetInput {
  low: Partial<LongLetInput>;
  base: LongLetInput;
  high: Partial<LongLetInput>;
}

export interface ScenarioSetResult {
  low: Result<LongLetEconomics>;
  base: Result<LongLetEconomics>;
  high: Result<LongLetEconomics>;
}

export function scenarioSets(sets: ScenarioSetInput | null | undefined): ScenarioSetResult {
  if (!isPresent(sets) || !isPresent(sets.base)) {
    const missing = fail<LongLetEconomics>('A base input set is required.', ['base']);
    return { low: missing, base: missing, high: missing };
  }
  const run = (overrides: Partial<LongLetInput> | null | undefined): Result<LongLetEconomics> =>
    longLetEconomics({ ...sets.base, ...(overrides ?? {}) });
  return { low: run(sets.low), base: longLetEconomics(sets.base), high: run(sets.high) };
}
