import { describe, expect, it } from 'vitest';
import type { LoanTerms } from './loan';
import type { LongLetInput } from './long-let';
import type { Result } from './result';
import type { SensitivityCell } from './sensitivity';
import { scenarioSets, sensitivityGrid } from './sensitivity';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
  return result.value;
}

function failure<T>(result: Result<T>): { reason: string; missing?: string[] } {
  if (result.ok) throw new Error('expected a failure, got ok');
  return result;
}

function netYields(cells: SensitivityCell[]): number[] {
  return cells.map((cell) => unwrap(unwrap(cell.outcome).netYieldPercent));
}

/** The brief's hypothetical example again: 2 × NGN 3m, 10% vacancy, NGN 1.2m opex, NGN 100m cost. */
const base: LongLetInput = {
  unitGroups: [{ units: 2, annualRentPerUnit: 3_000_000 }],
  vacancyRate: 0.1,
  collectionLossRate: 0,
  otherAnnualIncome: 0,
  operatingExpenses: {
    managementFee: { fixedAmount: 0 },
    maintenance: 500_000,
    insurance: 200_000,
    serviceCosts: 300_000,
    unrecoverableCharges: 200_000,
  },
  tax: { kind: 'none' },
  capexReserve: 0,
  annualDebtService: 0,
  denominator: { kind: 'development_cost', amount: 100_000_000 },
  equity: 50_000_000,
};

/** Hypothetical loan: NGN 50m at 20% over 10 years, annual annuity. */
const loan: LoanTerms = {
  principal: 50_000_000,
  annualInterestRate: 0.2,
  termYears: 10,
  repayment: 'annuity',
  paymentsPerYear: 1,
};

describe('sensitivityGrid', () => {
  it('varies vacancy, rents and costs one at a time around the base', () => {
    const grid = unwrap(
      sensitivityGrid(
        { longLet: base },
        { vacancy: [0, 0.1, 0.2], rents: [0.9, 1, 1.1], costs: [0.8, 1, 1.2] },
      ),
    );
    expect(grid.debtServiceSource).toBe('explicit');
    expect(unwrap(grid.base.netYieldPercent)).toBeCloseTo(4.2, 10);

    expect(grid.vacancy.map((c) => c.value)).toEqual([0, 0.1, 0.2]);
    expect(netYields(grid.vacancy).map((y) => Number(y.toFixed(6)))).toEqual([4.8, 4.2, 3.6]);
    expect(netYields(grid.rents).map((y) => Number(y.toFixed(6)))).toEqual([3.66, 4.2, 4.74]);
    expect(netYields(grid.costs).map((y) => Number(y.toFixed(6)))).toEqual([5.25, 4.2, 3.5]);

    const costCells = grid.costs.map((c) => unwrap(c.outcome));
    expect(costCells.map((c) => c.denominatorAmount)).toEqual([
      80_000_000, 100_000_000, 120_000_000,
    ]);
    expect(costCells.every((c) => Math.abs(c.cashFlowAfterDebt - 4_200_000) < 1e-6)).toBe(true);
    expect(grid.interest).toEqual([]);
    expect(grid.completionDelayMonths).toEqual([]);
  });

  it('needs loan terms for the interest dimension and then recomputes debt service per rate', () => {
    const withoutLoan = unwrap(sensitivityGrid({ longLet: base }, { interest: [0.15, 0.25] }));
    expect(withoutLoan.interest).toHaveLength(2);
    expect(failure(withoutLoan.interest[0]!.outcome).missing).toEqual(['base.loan']);

    const withLoan = unwrap(
      sensitivityGrid({ longLet: base, loan }, { interest: [0.15, 0.2, 0.25] }),
    );
    expect(withLoan.debtServiceSource).toBe('loan');
    // 50m × 0.2 / (1 − 1.2^−10)
    expect(withLoan.base.annualDebtService).toBeCloseTo(11_926_137.84, 2);
    const cells = withLoan.interest.map((c) => unwrap(c.outcome));
    expect(cells[1]!.annualDebtService).toBeCloseTo(withLoan.base.annualDebtService, 6);
    expect(cells[0]!.annualDebtService).toBeLessThan(cells[1]!.annualDebtService);
    expect(cells[2]!.annualDebtService).toBeGreaterThan(cells[1]!.annualDebtService);
    expect(cells.every((c) => Math.abs(unwrap(c.netYieldPercent) - 4.2) < 1e-9)).toBe(true);
    expect(cells[2]!.cashFlowAfterDebt).toBeLessThan(cells[0]!.cashFlowAfterDebt);
    expect(unwrap(cells[1]!.cashOnCashPercent)).toBeCloseTo(
      ((4_200_000 - withLoan.base.annualDebtService) / 50_000_000) * 100,
      6,
    );
  });

  it('needs an explicit holding cost for completion delays and reports deferred rent', () => {
    const noHoldingCost = unwrap(
      sensitivityGrid({ longLet: base }, { completionDelayMonths: [0, 6] }),
    );
    expect(failure(noHoldingCost.completionDelayMonths[1]!.outcome).missing).toEqual([
      'base.delay.holdingCostPerMonth',
    ]);

    const grid = unwrap(
      sensitivityGrid(
        { longLet: base, delay: { holdingCostPerMonth: 500_000 } },
        { completionDelayMonths: [0, 6] },
      ),
    );
    const [onTime, late] = grid.completionDelayMonths.map((c) => unwrap(c.outcome));
    expect(onTime?.denominatorAmount).toBe(100_000_000);
    expect(unwrap(onTime!.netYieldPercent)).toBeCloseTo(4.2, 10);
    expect(onTime?.rentDeferredDuringDelay).toBe(0);
    expect(late?.denominatorAmount).toBe(103_000_000);
    expect(unwrap(late!.netYieldPercent)).toBeCloseTo(4.2 / 1.03, 10);
    expect(late?.rentDeferredDuringDelay).toBeCloseTo(2_700_000, 6);
  });

  it('fails individual cells for invalid variations without failing the grid', () => {
    const grid = unwrap(
      sensitivityGrid({ longLet: base }, { vacancy: [0.05, 1.5], rents: [Number.NaN] }),
    );
    expect(grid.vacancy[0]!.outcome.ok).toBe(true);
    expect(failure(grid.vacancy[1]!.outcome).reason).toMatch(/fraction between 0 and 1/);
    expect(failure(grid.rents[0]!.outcome).reason).toMatch(/finite number/);
  });

  it('fails when the base scenario itself is invalid', () => {
    expect(failure(sensitivityGrid(undefined, {})).missing).toEqual(['base.longLet']);
    expect(
      failure(sensitivityGrid({ longLet: { ...base, vacancyRate: 2 } }, { vacancy: [0.1] })).reason,
    ).toMatch(/vacancyRate/);
  });
});

describe('scenarioSets', () => {
  it('runs the long-let model for low, base and high input sets', () => {
    const sets = scenarioSets({
      low: { vacancyRate: 0.2 },
      base,
      high: { vacancyRate: 0.05 },
    });
    expect(unwrap(unwrap(sets.low).netYieldPercent)).toBeCloseTo(3.6, 10);
    expect(unwrap(unwrap(sets.base).netYieldPercent)).toBeCloseTo(4.2, 10);
    expect(unwrap(unwrap(sets.high).netYieldPercent)).toBeCloseTo(4.5, 10);
  });

  it('accepts complete input sets and keeps an invalid set from hiding the others', () => {
    const sets = scenarioSets({
      low: { ...base, unitGroups: [{ units: 2, annualRentPerUnit: 2_500_000 }] },
      base,
      high: { vacancyRate: -0.1 },
    });
    expect(unwrap(sets.low).scheduledAnnualRent).toBe(5_000_000);
    expect(sets.base.ok).toBe(true);
    expect(failure(sets.high).reason).toMatch(/vacancyRate must be a fraction/);
    expect(scenarioSets(undefined).base.ok).toBe(false);
  });
});
