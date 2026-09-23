import { describe, expect, it } from 'vitest';
import type { DatedCashFlow } from './npv-irr';
import { countSignChanges, irr, npv } from './npv-irr';
import type { Result } from './result';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
  return result.value;
}

function failure<T>(result: Result<T>): { reason: string; missing?: string[] } {
  if (result.ok) throw new Error('expected a failure, got ok');
  return result;
}

const flows: DatedCashFlow[] = [
  { period: 0, amount: -100 },
  { period: 1, amount: 10 },
  { period: 2, amount: 10 },
];
const exit = { exitValue: 120, sellingCosts: 5 };

describe('npv', () => {
  it('requires an explicit discount rate', () => {
    expect(failure(npv(undefined, flows, exit)).missing).toEqual(['discountRate']);
    expect(failure(npv(Number.NaN, flows, exit)).reason).toMatch(
      /discountRate must be a finite number/,
    );
    expect(failure(npv(-1, flows, exit)).reason).toMatch(/greater than -1/);
  });

  it('adds net exit proceeds to the final period and discounts each dated period', () => {
    const result = unwrap(npv(0.1, flows, exit));
    // -100 + 10/1.1 + (10 + 115)/1.21
    expect(result.npv).toBeCloseTo(12.396694, 6);
    expect(result.finalPeriod).toBe(2);
    expect(result.netExitProceeds).toBe(115);
    expect(result.cashFlows).toEqual([
      { period: 0, amount: -100 },
      { period: 1, amount: 10 },
      { period: 2, amount: 125 },
    ]);
  });

  it('requires the exit value and selling costs explicitly', () => {
    expect(failure(npv(0.1, flows, undefined)).missing).toEqual([
      'exit.exitValue',
      'exit.sellingCosts',
    ]);
    expect(unwrap(npv(0, flows, { exitValue: 0, sellingCosts: 0 })).npv).toBe(-80);
  });

  it('sums undiscounted at a zero rate and aggregates flows dated in the same period', () => {
    expect(unwrap(npv(0, flows, exit)).npv).toBe(35);
    const split = unwrap(
      npv(
        0.1,
        [
          { period: 0, amount: -50 },
          { period: 1, amount: 110 },
          { period: 0, amount: -50 },
        ],
        { exitValue: 0, sellingCosts: 0 },
      ),
    );
    expect(split.npv).toBeCloseTo(0, 10);
    expect(split.cashFlows).toEqual([
      { period: 0, amount: -100 },
      { period: 1, amount: 110 },
    ]);
  });

  it('rejects incomplete dated cash flows', () => {
    expect(failure(npv(0.1, undefined, exit)).missing).toEqual(['cashFlows']);
    expect(failure(npv(0.1, [], exit)).reason).toMatch(/at least one dated period/);
    expect(failure(npv(0.1, [{ period: 1.5, amount: 10 }], exit)).reason).toMatch(
      /cashFlows\[0\].period must be a whole number/,
    );
  });
});

describe('countSignChanges', () => {
  it('counts changes between non-zero amounts in period order', () => {
    expect(countSignChanges(flows)).toBe(1);
    expect(
      countSignChanges([
        { period: 0, amount: -1 },
        { period: 1, amount: 0 },
        { period: 2, amount: 1 },
      ]),
    ).toBe(1);
    expect(
      countSignChanges([
        { period: 2, amount: -132 },
        { period: 0, amount: -100 },
        { period: 1, amount: 230 },
      ]),
    ).toBe(2);
  });
});

describe('irr', () => {
  it('solves a simple one-period return exactly and labels it unique', () => {
    const result = unwrap(
      irr([
        { period: 0, amount: -100 },
        { period: 1, amount: 110 },
      ]),
    );
    expect(result.irr).toBeCloseTo(0.1, 10);
    expect(result.uniqueness).toBe('unique');
    expect(result.signChanges).toBe(1);
    expect(Math.abs(result.npvAtIrr)).toBeLessThan(1e-8);
  });

  it('converges on a multi-period series and zeroes the NPV at that rate', () => {
    const series: DatedCashFlow[] = [
      { period: 0, amount: -1000 },
      { period: 1, amount: 300 },
      { period: 2, amount: 400 },
      { period: 3, amount: 500 },
    ];
    const result = unwrap(irr(series));
    expect(result.irr).toBeGreaterThan(0.088);
    expect(result.irr).toBeLessThan(0.09);
    expect(unwrap(npv(result.irr, series, { exitValue: 0, sellingCosts: 0 })).npv).toBeCloseTo(
      0,
      6,
    );
  });

  it('includes an explicit exit in the final period', () => {
    const result = unwrap(irr(flows, exit));
    expect(result.irr).toBeGreaterThan(0.16);
    expect(result.irr).toBeLessThan(0.18);
    expect(unwrap(npv(result.irr, flows, exit)).npv).toBeCloseTo(0, 6);
  });

  it('flags cash flows whose signs change more than once as not unique', () => {
    // NPV is zero at both 10% and 20%.
    const twoRoots: DatedCashFlow[] = [
      { period: 0, amount: -100 },
      { period: 1, amount: 230 },
      { period: 2, amount: -132 },
    ];
    expect(failure(irr(twoRoots)).reason).toBe('irr_not_unique');

    const attempted = unwrap(irr(twoRoots, null, { onMultipleSignChanges: 'attempt' }));
    expect(attempted.uniqueness).toBe('unverified');
    expect(attempted.signChanges).toBe(2);
    expect(Math.abs(attempted.npvAtIrr)).toBeLessThan(1e-8);
  });

  it('reports no solution when the signs never change', () => {
    expect(
      failure(
        irr([
          { period: 0, amount: 100 },
          { period: 1, amount: 50 },
        ]),
      ).reason,
    ).toBe('irr_no_solution');
    expect(
      failure(
        irr([
          { period: 0, amount: 0 },
          { period: 1, amount: 0 },
        ]),
      ).reason,
    ).toBe('irr_no_solution');
  });

  it('handles a loss-making series with a negative rate and a long monthly series', () => {
    const loss = unwrap(
      irr([
        { period: 0, amount: -100 },
        { period: 1, amount: 50 },
      ]),
    );
    expect(loss.irr).toBeCloseTo(-0.5, 10);

    const monthly: DatedCashFlow[] = [{ period: 0, amount: -1_000_000 }];
    for (let period = 1; period <= 36; period += 1) monthly.push({ period, amount: 35_000 });
    const result = unwrap(irr(monthly));
    expect(result.uniqueness).toBe('unique');
    expect(result.irr).toBeGreaterThan(0);
    expect(unwrap(npv(result.irr, monthly, { exitValue: 0, sellingCosts: 0 })).npv).toBeCloseTo(
      0,
      4,
    );
  });

  it('validates its inputs before solving', () => {
    expect(failure(irr(undefined)).missing).toEqual(['cashFlows']);
    expect(failure(irr(flows, { exitValue: -1, sellingCosts: 0 })).reason).toMatch(
      /exit.exitValue must be a finite amount/,
    );
  });
});
