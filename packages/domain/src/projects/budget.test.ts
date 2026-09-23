import { describe, expect, it } from 'vitest';
import { budgetVarianceToJson, computeBudgetVariance } from './budget';
import { areaRateAmount, boqLineAmount, scaledDecimal } from './money-math';

describe('money math', () => {
  it('multiplies BOQ quantity and rate without floating point and rounds half up once', () => {
    // 12.345 m³ × ₦1,234.56 (123456 kobo) = 1,524,064.32 kobo → 1,524,064
    expect(boqLineAmount('12.345', 123456n)).toBe(1524064n);
    // 0.5 × 3 kobo = 1.5 → 2 (half up)
    expect(boqLineAmount('0.5', 3n)).toBe(2n);
    expect(boqLineAmount('10', 250000n)).toBe(2500000n);
  });

  it('rejects more decimals than the column allows and negative values', () => {
    expect(() => boqLineAmount('1.2345', 100n)).toThrow(/decimal places/);
    expect(() => boqLineAmount('-1', 100n)).toThrow(/negative/);
    expect(() => scaledDecimal('abc', 2)).toThrow(/invalid decimal/);
  });

  it('computes an area-rate budget from m² and rate per m²', () => {
    // 350.25 m² × ₦180,000/m² (18,000,000 kobo) = 6,304,500,000 kobo
    expect(areaRateAmount('350.25', 18_000_000n)).toBe(6_304_500_000n);
    expect(() => areaRateAmount('0', 100n)).toThrow(/positive/);
  });
});

describe('computeBudgetVariance', () => {
  const base = {
    contingencyKobo: 0n,
    approvedChangeOrderDeltaKobo: 0n,
    pendingChangeOrderDeltaKobo: 0n,
  };

  it('reports no variance without an approved budget and never invents a forecast', () => {
    const v = computeBudgetVariance({
      ...base,
      approvedBaseKobo: null,
      committedKobo: 500n,
      actualKobo: 200n,
    });
    expect(v.status).toBe('no_approved_budget');
    expect(v.forecastFinalCostKobo).toBeNull();
    expect(v.varianceKobo).toBeNull();
    expect(v.exposureKobo).toBe(500n);
  });

  it('forecasts the approved total while commitments stay within budget', () => {
    const v = computeBudgetVariance({
      ...base,
      approvedBaseKobo: 10_000_000n,
      contingencyKobo: 500_000n,
      committedKobo: 4_000_000n,
      actualKobo: 1_500_000n,
    });
    expect(v.approvedTotalKobo).toBe(10_500_000n);
    expect(v.exposureKobo).toBe(4_000_000n);
    expect(v.remainingKobo).toBe(6_500_000n);
    expect(v.costToCompleteKobo).toBe(6_500_000n);
    expect(v.forecastFinalCostKobo).toBe(10_500_000n);
    expect(v.varianceKobo).toBe(0n);
    expect(v.variancePct).toBe(0);
    expect(v.status).toBe('within_budget');
  });

  it('recognises an evidenced overrun when commitments exceed the budget', () => {
    const v = computeBudgetVariance({
      ...base,
      approvedBaseKobo: 10_000_000n,
      committedKobo: 12_000_000n,
      actualKobo: 3_000_000n,
    });
    expect(v.status).toBe('over_committed');
    expect(v.costToCompleteKobo).toBe(0n);
    expect(v.forecastFinalCostKobo).toBe(12_000_000n);
    expect(v.varianceKobo).toBe(-2_000_000n);
    expect(v.variancePct).toBe(-20);
  });

  it('uses actuals as exposure when they run ahead of commitments', () => {
    const v = computeBudgetVariance({
      ...base,
      approvedBaseKobo: 1_000n,
      committedKobo: 900n,
      actualKobo: 1_200n,
    });
    expect(v.status).toBe('over_spent');
    expect(v.exposureKobo).toBe(1_200n);
    expect(v.forecastFinalCostKobo).toBe(1_200n);
    expect(v.varianceKobo).toBe(-200n);
  });

  it('keeps pending change orders out of the forecast but shows the exposure', () => {
    const v = computeBudgetVariance({
      ...base,
      approvedBaseKobo: 10_000n,
      committedKobo: 0n,
      actualKobo: 0n,
      approvedChangeOrderDeltaKobo: 2_000n,
      pendingChangeOrderDeltaKobo: 750n,
    });
    expect(v.forecastFinalCostKobo).toBe(10_000n);
    expect(v.exposureIfPendingApprovedKobo).toBe(10_750n);
    expect(v.notes.join(' ')).toMatch(/Pending change orders/);
    expect(v.notes.join(' ')).toMatch(/approved and applied change order/);
  });

  it('labels the progress extrapolation as a scenario and omits it without progress', () => {
    const none = computeBudgetVariance({
      ...base,
      approvedBaseKobo: 100n,
      committedKobo: 0n,
      actualKobo: 0n,
      percentComplete: 0,
    });
    expect(none.progressExtrapolation).toBeNull();
    const some = computeBudgetVariance({
      ...base,
      approvedBaseKobo: 100n,
      committedKobo: 0n,
      actualKobo: 50n,
      percentComplete: 40,
    });
    expect(some.progressExtrapolation).toEqual({
      label: 'scenario_not_a_forecast',
      percentComplete: 40,
      finalCostKobo: 125n,
    });
  });

  it('serialises every kobo figure as a decimal string', () => {
    const v = computeBudgetVariance({
      ...base,
      approvedBaseKobo: 10n,
      committedKobo: 3n,
      actualKobo: 1n,
    });
    const json = budgetVarianceToJson(v);
    expect(json['approvedTotalKobo']).toBe('10');
    expect(json['varianceKobo']).toBe('0');
    expect(json['pendingChangeOrderDeltaKobo']).toBe('0');
    expect(JSON.stringify(json)).not.toContain('n"');
  });
});
