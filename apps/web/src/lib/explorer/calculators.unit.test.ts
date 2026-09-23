import { describe, expect, it } from 'vitest';
import { normalizeCalculatorResponse, pickKey, sensitivitySeries } from './calculators';

const longLet = {
  scheduledAnnualRent: 6_000_000,
  effectiveIncome: 5_400_000,
  operatingExpenses: { total: 1_200_000, managementFee: 0, managementFeeBasis: 'fixed' },
  noi: 4_200_000,
  capexReserve: 0,
  capexReserveTreatment: 'reported_separately',
  annualDebtService: 0,
  cashFlowAfterDebt: 4_200_000,
  denominator: { kind: 'development_cost', amount: 100_000_000 },
  grossYieldPercent: { ok: true, value: 6 },
  netYieldPercent: { ok: true, value: 4.2 },
  simplePaybackYears: { ok: true, value: 23.8 },
};

const developmentCost = {
  total: 100_000_000,
  components: {
    land: 30_000_000,
    acquisitionCosts: 0,
    buildCost: 60_000_000,
    professionalFees: 5_000_000,
    approvals: 1_000_000,
    utilitiesAndExternalWorks: 2_000_000,
    contingency: 2_000_000,
    financingDuringBuild: 0,
  },
  build: { basis: 'area_rate', amount: 60_000_000, areaRateCrossCheck: null },
};

describe('normalizeCalculatorResponse', () => {
  it('reads camelCase results wrapped in {ok,value}', () => {
    const result = normalizeCalculatorResponse({
      developmentCost: { ok: true, value: developmentCost },
      longLet: { ok: true, value: longLet },
      shortStay: { ok: false, reason: 'No short-stay inputs.', missing: ['shortStay'] },
      phasing: { ok: false, reason: 'Needs a start month.' },
      npv: { ok: false, reason: 'NPV needs a discount rate.', missing: ['discountRate'] },
      irr: { ok: false, reason: 'irr_no_solution' },
      sensitivity: { ok: true, value: { vacancy: [{ variable: 'vacancy', value: 0.1, outcome: { ok: true, value: { netYieldPercent: { ok: true, value: 3.9 }, noi: 3_900_000, cashFlowAfterDebt: 3_900_000 } } }] } },
      scenarioSets: { low: { ok: false, reason: 'no low' }, base: { ok: true, value: longLet }, high: { ok: true, value: { ...longLet, noi: 5_000_000 } } },
      disclaimer: 'Scenarios, not valuations.',
    });
    expect(result.empty).toBe(false);
    expect(result.developmentCost.ok && result.developmentCost.value.total).toBe(100_000_000);
    expect(result.longLet.ok && result.longLet.value.netYieldPercent).toEqual({ ok: true, value: 4.2 });
    expect(result.shortStay).toEqual({ ok: false, reason: 'No short-stay inputs.', missing: ['shortStay'] });
    expect(result.npv.ok).toBe(false);
    expect(result.sensitivity.ok && result.sensitivity.value.vacancy.length).toBe(1);
    expect(result.sets?.low.ok).toBe(false);
    expect(result.sets?.high.ok && result.sets.high.value.noi).toBe(5_000_000);
    expect(result.disclaimer).toBe('Scenarios, not valuations.');
  });

  it('tolerates snake_case keys, a results wrapper and bare values', () => {
    const result = normalizeCalculatorResponse({
      results: {
        development_cost: developmentCost,
        long_let: longLet,
        npv_irr: { npv: { ok: true, value: { npv: 1_000, discountRate: 0.12 } }, irr: { ok: true, value: { irr: 0.15, uniqueness: 'unique' } } },
      },
    });
    expect(result.developmentCost.ok).toBe(true);
    expect(result.longLet.ok).toBe(true);
    expect(result.npv.ok && result.npv.value.npv).toBe(1_000);
    expect(result.irr.ok && result.irr.value.irr).toBe(0.15);
  });

  it('reads per-set nesting { base, low, high }', () => {
    const result = normalizeCalculatorResponse({
      base: { developmentCost: { ok: true, value: developmentCost }, longLet: { ok: true, value: longLet } },
      low: { longLet: { ok: true, value: { ...longLet, noi: 1 } } },
      high: { longLet: { ok: false, reason: 'high failed' } },
    });
    expect(result.developmentCost.ok).toBe(true);
    expect(result.sets?.low.ok && result.sets.low.value.noi).toBe(1);
    expect(result.sets?.high).toMatchObject({ ok: false, reason: 'high failed' });
  });

  it('never fabricates a number from an unrecognised shape', () => {
    const result = normalizeCalculatorResponse({ longLet: { ok: true, value: { noi: 'a lot' } } });
    expect(result.longLet.ok).toBe(false);
    expect(result.longLet.ok ? '' : result.longLet.reason).toContain('unexpected shape');
    expect(normalizeCalculatorResponse('nonsense').empty).toBe(true);
    expect(normalizeCalculatorResponse({ unrelated: 1 }).empty).toBe(true);
  });

  it('builds sensitivity series with nulls for failed cells', () => {
    const series = sensitivitySeries([
      { variable: 'rents', value: 0.9, outcome: { ok: true, value: { netYieldPercent: { ok: true, value: 3 }, noi: 1, cashFlowAfterDebt: 1 } } },
      { variable: 'rents', value: 1.1, outcome: { ok: false, reason: 'no' } },
      { variable: 'rents', value: 1.2, outcome: { ok: true, value: { netYieldPercent: { ok: false, reason: 'zero denominator' }, noi: 1, cashFlowAfterDebt: 1 } } },
    ]);
    expect(series.map((p) => p.netYield)).toEqual([3, null, null]);
    expect(series[2]?.reason).toBe('zero denominator');
  });

  it('pickKey matches keys regardless of case and separators', () => {
    expect(pickKey({ Development_Cost: 1 }, ['developmentCost'])).toBe(1);
    expect(pickKey({ other: 1 }, ['developmentCost'])).toBeUndefined();
  });
});
