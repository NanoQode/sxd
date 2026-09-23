import { describe, expect, it } from 'vitest';
import { calculatorRunRequestSchema, calculatorRunResponseSchema } from '@simplexd/contracts';
import type { LongLetEconomics } from '@simplexd/domain/finance';
import { runCalculatorSuite } from './calculators';

const asOf = new Date('2026-09-23T10:00:00.000Z');

/** The brief's hypothetical example (§6.4): entirely test assumptions, not seeded city prices. */
const briefExample = calculatorRunRequestSchema.parse({
  objective: 'long_term_rent',
  assumptions: {
    base: {
      landCostNaira: 0,
      boqTotalNaira: 100_000_000,
      units: [{ label: 'flats', count: 2, annualRentPerUnitNaira: 3_000_000 }],
      vacancyRate: 0.1,
      collectionLossRate: 0,
      opex: { maintenanceNaira: 1_200_000 },
      constructionMonths: 12,
    },
  },
  sensitivity: {
    vacancy: [0, 0.2],
    rents: [0.9],
    costs: [1.1],
    interest: [0.2],
    completionDelayMonths: [3],
  },
});

function longLetOf(
  result: ReturnType<typeof runCalculatorSuite>['sets']['base'],
): LongLetEconomics {
  if (!result.longLet?.ok) throw new Error('expected long-let economics');
  return result.longLet.value as LongLetEconomics;
}

describe('runCalculatorSuite', () => {
  it('reproduces the brief example: 6m / 5.4m / 4.2m / 6% / 4.2%', () => {
    const response = runCalculatorSuite(briefExample, asOf);
    expect(() => calculatorRunResponseSchema.parse(response)).not.toThrow();
    const economics = longLetOf(response.sets.base);
    expect(economics.scheduledAnnualRent).toBe(6_000_000);
    expect(economics.effectiveIncome).toBeCloseTo(5_400_000, 6);
    expect(economics.noi).toBeCloseTo(4_200_000, 6);
    expect(economics.grossYieldPercent).toEqual({ ok: true, value: 6 });
    expect(economics.netYieldPercent.ok && economics.netYieldPercent.value).toBeCloseTo(4.2, 10);
    expect(economics.denominator).toEqual({ kind: 'development_cost', amount: 100_000_000 });
    expect(response.sets.base.developmentCost.ok).toBe(true);
    expect(response.sets.base.derived.totalDevelopmentCostNaira).toBe(100_000_000);
    expect(response.sets.base.derived.netYieldPercent).toBeCloseTo(4.2, 10);
    expect(response.sets.base.derived.constructionDurationDays).toBe(360);
    expect(response.sets.low).toBeNull();
    expect(response.sets.high).toBeNull();
    expect(response.disclaimer).toContain('not valuations or investment advice');
  });

  it('echoes ok:false reasons for what cannot be computed instead of defaulting', () => {
    const response = runCalculatorSuite(briefExample, asOf);
    const base = response.sets.base;
    expect(base.npv).toMatchObject({ ok: false });
    expect(base.irr).toMatchObject({ ok: false });
    expect(base.phasing.ok).toBe(true);
    if (!response.sensitivity.ok) throw new Error(response.sensitivity.reason);
    const grid = response.sensitivity.value as {
      vacancy: Array<{ value: number; outcome: { ok: boolean } }>;
      interest: Array<{ outcome: { ok: boolean; reason?: string } }>;
      completionDelayMonths: Array<{ outcome: { ok: boolean } }>;
    };
    expect(grid.vacancy).toHaveLength(2);
    expect(grid.vacancy.every((c) => c.outcome.ok)).toBe(true);
    expect(grid.interest[0]?.outcome.ok).toBe(false);
    expect(grid.interest[0]?.outcome.reason).toContain('loan terms');
    expect(grid.completionDelayMonths[0]?.outcome.ok).toBe(true);
    expect(response.scenarioSets.low).toMatchObject({ ok: false, missing: ['low'] });
    expect(response.scenarioSets.base.ok).toBe(true);
  });

  it('reports missing land and areas rather than inventing them', () => {
    const request = calculatorRunRequestSchema.parse({
      objective: 'long_term_rent',
      assumptions: { base: { units: [{ count: 1, annualRentPerUnitNaira: 1_000_000 }] } },
    });
    const response = runCalculatorSuite(request, asOf);
    const cost = response.sets.base.developmentCost;
    expect(cost.ok).toBe(false);
    if (cost.ok) return;
    expect(cost.missing).toContain('land');
    expect(cost.missing).toEqual(expect.arrayContaining(['build.areaRate', 'build.boq']));
    expect(response.sets.base.longLet).toMatchObject({ ok: false });
    expect(response.sets.base.derived.totalDevelopmentCostNaira).toBeNull();
    expect(response.sets.base.derived.costPerM2Naira).toBeNull();
    expect(response.sets.base.derived.netYieldPercent).toBeNull();
  });

  it('computes NPV and IRR when a discount rate and an explicit exit are supplied', () => {
    const request = calculatorRunRequestSchema.parse({
      objective: 'long_term_rent',
      assumptions: {
        base: {
          ...briefExample.assumptions.base,
          discountRate: 0.12,
          exitValueNaira: 150_000_000,
          sellingCostsFraction: 0.05,
          holdYears: 5,
        },
        // Zod fills defaults for absent keys of the partial low/high sets, so a set is sent whole.
        high: {
          ...briefExample.assumptions.base,
          units: [{ label: 'flats', count: 2, annualRentPerUnitNaira: 3_600_000 }],
        },
      },
    });
    const response = runCalculatorSuite(request, asOf);
    expect(response.sets.base.npv.ok).toBe(true);
    expect(response.sets.base.irr.ok).toBe(true);
    expect(response.sets.high).not.toBeNull();
    expect(longLetOf(response.sets.high!).scheduledAnnualRent).toBe(7_200_000);
    expect(response.scenarioSets.high.ok).toBe(true);
  });

  it('keeps short stays separate from annual leases', () => {
    const request = calculatorRunRequestSchema.parse({
      objective: 'short_stay',
      assumptions: {
        base: {
          landCostNaira: 10_000_000,
          boqTotalNaira: 40_000_000,
          shortStay: {
            availableNightsPerYear: 300,
            occupiedNightFraction: 0.5,
            nightlyRateNaira: 50_000,
            platformChargeFraction: 0.15,
            cleaningCostPerStayNaira: 10_000,
            averageLengthOfStayNights: 3,
            operatingCostsNaira: 1_000_000,
          },
        },
      },
    });
    const response = runCalculatorSuite(request, asOf);
    expect(response.sets.base.economicsKind).toBe('short_stay');
    expect(response.sets.base.longLet).toBeNull();
    expect(response.sets.base.shortStay?.ok).toBe(true);
    const value = response.sets.base.shortStay!.ok
      ? (response.sets.base.shortStay!.value as { grossBookingRevenue: number })
      : null;
    expect(value?.grossBookingRevenue).toBe(150 * 50_000);
    expect(response.sensitivity).toMatchObject({ ok: false });
  });
});
