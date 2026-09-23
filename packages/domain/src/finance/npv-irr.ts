import type { Result } from './result';
import { fail, InputCheck, isPresent, ok } from './result';

/**
 * A dated cash flow: `period` is the whole number of periods after the
 * valuation date (0 = today), `amount` is signed whole naira (outflows
 * negative). Periods must all be the same length (e.g. years or months), and
 * the discount rate must be per period.
 */
export interface DatedCashFlow {
  period: number;
  amount: number;
}

/** Explicit exit: sale value less selling costs, added to the final period. */
export interface ExitAssumption {
  exitValue: number;
  sellingCosts: number;
}

export interface NpvResult {
  npv: number;
  discountRate: number;
  finalPeriod: number;
  /** `exitValue - sellingCosts`, already included in the final period of `cashFlows`. */
  netExitProceeds: number;
  /** The series actually discounted: one entry per period, sorted, exit included. */
  cashFlows: DatedCashFlow[];
}

interface PreparedCashFlows {
  flows: DatedCashFlow[];
  finalPeriod: number;
  netExitProceeds: number;
}

/** Validates, aggregates flows with the same period, sorts, and adds the exit to the last period. */
function prepareCashFlows(
  cashFlows: readonly DatedCashFlow[] | null | undefined,
  exit: ExitAssumption | null | undefined,
  exitRequired: boolean,
): Result<PreparedCashFlows> {
  const check = new InputCheck();
  const byPeriod = new Map<number, number>();
  if (!Array.isArray(cashFlows)) {
    check.absent('cashFlows');
  } else if (cashFlows.length === 0) {
    check.problem('cashFlows must contain at least one dated period');
  } else {
    cashFlows.forEach((flow, i) => {
      const period = check.integer(`cashFlows[${i}].period`, flow?.period, 0);
      const amount = check.number(`cashFlows[${i}].amount`, flow?.amount);
      if (Number.isFinite(period) && Number.isFinite(amount)) {
        byPeriod.set(period, (byPeriod.get(period) ?? 0) + amount);
      }
    });
  }

  let netExitProceeds = 0;
  if (isPresent(exit)) {
    const exitValue = check.amount('exit.exitValue', exit.exitValue);
    const sellingCosts = check.amount('exit.sellingCosts', exit.sellingCosts);
    if (Number.isFinite(exitValue) && Number.isFinite(sellingCosts)) {
      netExitProceeds = exitValue - sellingCosts;
    }
  } else if (exitRequired) {
    check.absent('exit.exitValue');
    check.absent('exit.sellingCosts');
  }
  if (check.failed) return check.failure();

  const periods = [...byPeriod.keys()].sort((a, b) => a - b);
  const finalPeriod = periods[periods.length - 1] ?? 0;
  byPeriod.set(finalPeriod, (byPeriod.get(finalPeriod) ?? 0) + netExitProceeds);
  const flows = periods.map((period) => ({ period, amount: byPeriod.get(period) ?? 0 }));
  return ok({ flows, finalPeriod, netExitProceeds });
}

function presentValue(flows: readonly DatedCashFlow[], rate: number): number {
  let total = 0;
  for (const flow of flows) total += flow.amount / (1 + rate) ** flow.period;
  return total;
}

function presentValueDerivative(flows: readonly DatedCashFlow[], rate: number): number {
  let total = 0;
  for (const flow of flows) {
    total -= (flow.period * flow.amount) / (1 + rate) ** (flow.period + 1);
  }
  return total;
}

/**
 * Net present value of dated cash flows plus an explicit exit. Brief §6.4:
 * "NPV/IRR expansion requires an explicit discount rate, exit value, selling
 * costs and complete dated cash flows." None of them is defaulted.
 *
 * @param discountRate per-period rate as a fraction (0.12 = 12% per period).
 */
export function npv(
  discountRate: number | null | undefined,
  cashFlows: readonly DatedCashFlow[] | null | undefined,
  exit: ExitAssumption | null | undefined,
): Result<NpvResult> {
  const check = new InputCheck();
  const rate = check.number('discountRate', discountRate);
  if (Number.isFinite(rate) && rate <= -1) check.problem('discountRate must be greater than -1');
  const prepared = prepareCashFlows(cashFlows, exit, true);
  check.absorb(prepared);
  if (check.failed || !prepared.ok) return check.failure();
  return ok({
    npv: presentValue(prepared.value.flows, rate),
    discountRate: rate,
    finalPeriod: prepared.value.finalPeriod,
    netExitProceeds: prepared.value.netExitProceeds,
    cashFlows: prepared.value.flows,
  });
}

export type IrrFailureReason = 'irr_not_unique' | 'irr_no_solution';

/** Descartes' rule of signs: with exactly one sign change the IRR is unique. */
export type IrrUniqueness = 'unique' | 'unverified';

export interface IrrResult {
  /** Per-period rate as a fraction. */
  irr: number;
  uniqueness: IrrUniqueness;
  signChanges: number;
  iterations: number;
  /** Residual NPV at `irr`; effectively zero. */
  npvAtIrr: number;
}

export interface IrrOptions {
  /**
   * What to do when the cash-flow signs change more than once, so several
   * rates may zero the NPV. `'reject'` (default) fails with `irr_not_unique`;
   * `'attempt'` returns one root labelled `uniqueness: 'unverified'`.
   */
  onMultipleSignChanges?: 'reject' | 'attempt';
}

/** Number of sign changes in the period-ordered amounts, ignoring zeros. */
export function countSignChanges(flows: readonly DatedCashFlow[]): number {
  let previous = 0;
  let changes = 0;
  for (const flow of [...flows].sort((a, b) => a.period - b.period)) {
    const sign = Math.sign(flow.amount);
    if (sign === 0) continue;
    if (previous !== 0 && sign !== previous) changes += 1;
    previous = sign;
  }
  return changes;
}

interface Root {
  rate: number;
  iterations: number;
}

/**
 * Rates at which NPV(r) is sampled to find a sign change: fine linear steps
 * from -99% to +1000% per period, then doubling up to the search limit. The
 * scan (rather than the two end points alone) matters when the signs change
 * more than once, because NPV can then have the same sign at both ends.
 */
const SCAN_RATES: readonly number[] = (() => {
  const rates: number[] = [];
  for (let i = 0; i <= 1099; i += 1) rates.push(-0.99 + i * 0.01);
  for (let rate = 20; rate <= 1e9; rate *= 2) rates.push(rate);
  return rates;
})();
const RATE_TOLERANCE = 1e-13;

interface Bracket {
  lo: number;
  fLo: number;
  hi: number;
}

/** The lowest pair of adjacent scan rates between which NPV(r) changes sign. */
function findBracket(f: (rate: number) => number): Bracket | null {
  let previousRate = Number.NaN;
  let previousValue = Number.NaN;
  for (const rate of SCAN_RATES) {
    const value = f(rate);
    if (!Number.isFinite(value)) continue;
    if (value === 0) return { lo: rate, fLo: 0, hi: rate };
    if (Number.isFinite(previousValue) && Math.sign(value) !== Math.sign(previousValue)) {
      return { lo: previousRate, fLo: previousValue, hi: rate };
    }
    previousRate = rate;
    previousValue = value;
  }
  return null;
}

/** Bracket a sign change of NPV(r), bisect to a coarse width, then polish with Newton. */
function solveIrr(flows: readonly DatedCashFlow[]): Root | null {
  const f = (rate: number): number => presentValue(flows, rate);
  const scale = flows.reduce((sum, flow) => sum + Math.abs(flow.amount), 0);
  const residualTolerance = scale * 1e-12;
  const bracket = findBracket(f);
  if (bracket === null) return null;
  let { lo, fLo, hi } = bracket;
  let iterations = 0;
  if (lo === hi) return { rate: lo, iterations };

  const bisect = (width: number): number => {
    let mid = (lo + hi) / 2;
    while (hi - lo > width && iterations < 2000) {
      mid = (lo + hi) / 2;
      const fMid = f(mid);
      iterations += 1;
      if (fMid === 0) {
        lo = mid;
        hi = mid;
        break;
      }
      if (Math.sign(fMid) === Math.sign(fLo)) {
        lo = mid;
        fLo = fMid;
      } else {
        hi = mid;
      }
    }
    return mid;
  };

  let rate = bisect(1e-6);
  for (let step = 0; step < 50; step += 1) {
    const value = f(rate);
    const slope = presentValueDerivative(flows, rate);
    iterations += 1;
    if (Math.abs(value) <= residualTolerance) return { rate, iterations };
    if (!Number.isFinite(slope) || slope === 0) break;
    const next = rate - value / slope;
    if (!Number.isFinite(next) || next <= lo || next >= hi) break;
    if (Math.abs(next - rate) <= RATE_TOLERANCE * Math.max(1, Math.abs(rate))) {
      return { rate: next, iterations };
    }
    rate = next;
  }

  rate = bisect(RATE_TOLERANCE);
  return hi - lo <= RATE_TOLERANCE * Math.max(1, Math.abs(rate)) ? { rate, iterations } : null;
}

/**
 * Internal rate of return of dated cash flows (per period). Brief §6.4:
 * "label failed/non-unique IRR solutions." Zero sign changes or no bracketed
 * root fail with `irr_no_solution`; more than one sign change fails with
 * `irr_not_unique` unless the caller opts to attempt a root, which is then
 * labelled `unverified`. An optional exit is added to the final period.
 */
export function irr(
  cashFlows: readonly DatedCashFlow[] | null | undefined,
  exit?: ExitAssumption | null,
  options?: IrrOptions,
): Result<IrrResult> {
  const prepared = prepareCashFlows(cashFlows, exit, false);
  if (!prepared.ok) return prepared;
  const flows = prepared.value.flows;
  const signChanges = countSignChanges(flows);
  if (signChanges === 0) return fail('irr_no_solution');
  if (signChanges > 1 && options?.onMultipleSignChanges !== 'attempt') {
    return fail('irr_not_unique');
  }
  const root = solveIrr(flows);
  if (root === null) return fail('irr_no_solution');
  return ok({
    irr: root.rate,
    uniqueness: signChanges === 1 ? 'unique' : 'unverified',
    signChanges,
    iterations: root.iterations,
    npvAtIrr: presentValue(flows, root.rate),
  });
}
