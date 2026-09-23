import { describe, expect, it } from 'vitest';
import type { PhasingInput } from './phasing';
import { addMonths, applyCompletionDelay, monthlyPhasing } from './phasing';
import type { Result } from './result';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
  return result.value;
}

function failure<T>(result: Result<T>): { reason: string; missing?: string[] } {
  if (result.ok) throw new Error('expected a failure, got ok');
  return result;
}

const plan = { constructionStart: { year: 2027, month: 1 }, constructionDurationMonths: 12 };

/** Hypothetical: NGN 1m rent and NGN 200k opex per month once operating; NGN 120m build. */
const phasing: PhasingInput = {
  ...plan,
  completionDelayMonths: 3,
  annualRentalIncome: 12_000_000,
  annualOperatingExpenses: 2_400_000,
  constructionSpend: { total: 120_000_000, profile: 'straight_line' },
  horizonMonths: 30,
};

describe('addMonths', () => {
  it('rolls over year boundaries in both directions', () => {
    expect(addMonths({ year: 2027, month: 11 }, 3)).toEqual({ year: 2028, month: 2 });
    expect(addMonths({ year: 2027, month: 1 }, -1)).toEqual({ year: 2026, month: 12 });
    expect(addMonths({ year: 2027, month: 6 }, 0)).toEqual({ year: 2027, month: 6 });
  });
});

describe('applyCompletionDelay', () => {
  it('starts rent the month after construction ends when there is no delay', () => {
    const schedule = unwrap(applyCompletionDelay(plan, 0));
    expect(schedule.plannedCompletion).toEqual({ year: 2028, month: 1 });
    expect(schedule.rentalStart).toEqual({ year: 2028, month: 1 });
    expect(schedule.rentalStartIndex).toBe(12);
  });

  it('postpones the rental start by the delay while keeping the planned completion', () => {
    const schedule = unwrap(applyCompletionDelay(plan, 3));
    expect(schedule.plannedCompletion).toEqual({ year: 2028, month: 1 });
    expect(schedule.plannedRentalStartIndex).toBe(12);
    expect(schedule.completionDelayMonths).toBe(3);
    expect(schedule.rentalStart).toEqual({ year: 2028, month: 4 });
    expect(schedule.rentalStartIndex).toBe(15);
  });

  it('requires an explicit whole-month delay and a valid start month', () => {
    expect(failure(applyCompletionDelay(plan, undefined)).missing).toEqual([
      'completionDelayMonths',
    ]);
    expect(failure(applyCompletionDelay(plan, -1)).reason).toMatch(/completionDelayMonths must be/);
    expect(
      failure(applyCompletionDelay({ ...plan, constructionStart: { year: 2027, month: 13 } }, 0))
        .reason,
    ).toMatch(/month must be between 1 and 12/);
  });
});

describe('monthlyPhasing', () => {
  it('phases construction spend, then a delay with no income, then operations', () => {
    const result = unwrap(monthlyPhasing(phasing));
    expect(result.months).toHaveLength(30);
    expect(result.schedule.rentalStartIndex).toBe(15);
    expect(result.stabilisationIndex).toBe(15);

    const construction = result.months.slice(0, 12);
    expect(construction.every((m) => m.phase === 'construction')).toBe(true);
    expect(construction.every((m) => m.constructionSpend === 10_000_000)).toBe(true);
    expect(construction.every((m) => m.rentalIncome === 0 && m.operatingExpenses === 0)).toBe(true);

    const delay = result.months.slice(12, 15);
    expect(delay.map((m) => m.phase)).toEqual(['delay', 'delay', 'delay']);
    expect(delay.every((m) => m.netCashFlow === 0)).toBe(true);

    const first = result.months[15];
    expect(first?.phase).toBe('stabilised');
    expect(first).toMatchObject({ year: 2028, month: 4, rentalIncome: 1_000_000 });
    expect(first?.operatingExpenses).toBeCloseTo(200_000, 6);
    expect(first?.netCashFlow).toBeCloseTo(800_000, 6);

    expect(result.totals.constructionSpend).toBeCloseTo(120_000_000, 6);
    expect(result.totals.rentalIncome).toBeCloseTo(15_000_000, 6);
    expect(result.totals.operatingExpenses).toBeCloseTo(3_000_000, 6);
    expect(result.totals.netCashFlow).toBeCloseTo(-108_000_000, 6);
    expect(result.months[29]?.cumulativeNetCashFlow).toBeCloseTo(-108_000_000, 6);
  });

  it('a longer completion delay postpones the first rent and lowers income over the same horizon', () => {
    const onTime = unwrap(monthlyPhasing({ ...phasing, completionDelayMonths: 0 }));
    const late = unwrap(monthlyPhasing({ ...phasing, completionDelayMonths: 6 }));
    const firstRent = (months: { index: number; rentalIncome: number }[]): number | undefined =>
      months.find((m) => m.rentalIncome > 0)?.index;
    expect(firstRent(onTime.months)).toBe(12);
    expect(firstRent(late.months)).toBe(18);
    expect(late.months.slice(12, 18).every((m) => m.rentalIncome === 0)).toBe(true);
    expect(onTime.totals.rentalIncome - late.totals.rentalIncome).toBeCloseTo(6_000_000, 6);
  });

  it('ramps occupancy linearly from the starting fraction to full occupancy', () => {
    const result = unwrap(
      monthlyPhasing({
        ...phasing,
        stabilisationRamp: { months: 4, startingOccupancyFraction: 0.5 },
      }),
    );
    expect(result.stabilisationIndex).toBe(19);
    const occupancy = result.months.slice(15, 20).map((m) => m.occupancyFraction);
    expect(occupancy).toEqual([0.5, 0.625, 0.75, 0.875, 1]);
    expect(result.months.slice(15, 19).every((m) => m.phase === 'ramp_up')).toBe(true);
    expect(result.months[15]?.rentalIncome).toBeCloseTo(500_000, 6);
    expect(result.months[15]?.operatingExpenses).toBeCloseTo(200_000, 6);
    expect(result.months[19]?.phase).toBe('stabilised');
  });

  it('requires the horizon and refuses to spread spend over zero construction months', () => {
    expect(
      failure(monthlyPhasing({ ...phasing, horizonMonths: undefined } as unknown as PhasingInput))
        .missing,
    ).toEqual(['horizonMonths']);
    expect(failure(monthlyPhasing({ ...phasing, constructionDurationMonths: 0 })).reason).toMatch(
      /constructionSpend needs constructionDurationMonths of at least 1/,
    );
    const alreadyBuilt = unwrap(
      monthlyPhasing({ ...phasing, constructionDurationMonths: 0, constructionSpend: null }),
    );
    expect(alreadyBuilt.schedule.rentalStartIndex).toBe(3);
  });
});
