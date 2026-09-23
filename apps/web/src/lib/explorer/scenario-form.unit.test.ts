import { describe, expect, it } from 'vitest';
import { scenarioAssumptionsSchema } from '@simplexd/contracts';
import {
  DEFAULT_ASSUMPTIONS,
  assumptionsAreUsable,
  assumptionsFromForm,
  buildScenarioCreate,
  defaultScenarioName,
  formFromAssumptions,
  missingAssumptionInputs,
  parseNumberInput,
  scenarioFormSchema,
  stableKey,
} from './scenario-form';
import { DEFAULT_FILTERS } from './url-state';

describe('scenario form mapping', () => {
  it('parses naira text with separators and keeps blanks as missing', () => {
    expect(parseNumberInput('₦ 12,500,000')).toBe(12_500_000);
    expect(parseNumberInput('')).toBeNull();
    expect(parseNumberInput('abc')).toBeNaN();
  });

  it('round-trips the default assumptions without inventing values', () => {
    const form = formFromAssumptions(DEFAULT_ASSUMPTIONS);
    const parsed = scenarioFormSchema.parse(form);
    const assumptions = assumptionsFromForm(parsed);
    expect(assumptions.base.landCostNaira).toBeNull();
    expect(assumptions.base.buildRateNairaPerM2).toBeNull();
    expect(assumptions.base.units).toEqual([]);
    expect(assumptions.low).toBeNull();
    expect(assumptions.high).toBeNull();
    expect(scenarioAssumptionsSchema.safeParse(assumptions).success).toBe(true);
    expect(assumptionsAreUsable(assumptions)).toBe(false);
    expect(missingAssumptionInputs(assumptions)).toEqual([
      'land cost',
      'gross floor area and build rate (or a priced BOQ total)',
      'at least one unit group with an annual rent (or short-stay inputs)',
    ]);
  });

  it('converts percentages to fractions and low/high overrides to partial sets', () => {
    const form = formFromAssumptions(DEFAULT_ASSUMPTIONS);
    const parsed = scenarioFormSchema.parse({
      ...form,
      landCostNaira: '30,000,000',
      grossFloorAreaM2: '400',
      buildRateNairaPerM2: '150000',
      vacancyPercent: '10',
      managementFeePercent: '5',
      taxKind: 'fraction_of_noi',
      taxPercent: '7.5',
      units: [{ label: '', count: '2', annualRentPerUnitNaira: '3000000' }],
      low: { ...form.low, enabled: true, vacancyPercent: '20', unitRents: ['2500000'] },
      high: { ...form.high, enabled: true, buildRateNairaPerM2: '' },
    });
    const assumptions = assumptionsFromForm(parsed);
    expect(assumptions.base.landCostNaira).toBe(30_000_000);
    expect(assumptions.base.vacancyRate).toBeCloseTo(0.1);
    expect(assumptions.base.opex.managementFeeFraction).toBeCloseTo(0.05);
    expect(assumptions.base.tax).toEqual({ kind: 'fraction_of_noi', value: 0.075 });
    expect(assumptions.base.units).toEqual([
      { label: 'Units', count: 2, annualRentPerUnitNaira: 3_000_000 },
    ]);
    expect(assumptions.low).toEqual({
      vacancyRate: 0.2,
      units: [{ label: 'Units', count: 2, annualRentPerUnitNaira: 2_500_000 }],
    });
    expect(assumptions.high).toBeNull();
    expect(assumptionsAreUsable(assumptions)).toBe(true);
    expect(scenarioAssumptionsSchema.safeParse(assumptions).success).toBe(true);

    const back = formFromAssumptions(assumptions);
    expect(back.vacancyPercent).toBe('10');
    expect(back.low.enabled).toBe(true);
    expect(back.low.unitRents).toEqual(['2500000']);
  });

  it('rejects non-numeric and out-of-range input with field messages', () => {
    const form = formFromAssumptions(DEFAULT_ASSUMPTIONS);
    const result = scenarioFormSchema.safeParse({
      ...form,
      landCostNaira: 'ten million',
      vacancyPercent: '150',
    });
    expect(result.success).toBe(false);
    const messages = result.success
      ? []
      : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    expect(messages).toContain('landCostNaira: Land cost must be a number');
    expect(messages.some((m) => m.startsWith('vacancyPercent:'))).toBe(true);
  });

  it('builds a scenario create payload with a default name and capped market ids', () => {
    const payload = buildScenarioCreate({
      name: '   ',
      objective: 'short_stay',
      mode: 'assumption',
      filters: DEFAULT_FILTERS,
      assumptions: DEFAULT_ASSUMPTIONS,
      priorities: {},
      marketIds: Array.from({ length: 12 }, (_, i) => `id-${i}`),
    });
    expect(payload.name.startsWith('Short stay scenario')).toBe(true);
    expect(payload.marketIds).toHaveLength(10);
    expect(defaultScenarioName('long_term_rent', new Date('2026-09-23T00:00:00Z'))).toBe(
      'Long term rent scenario · 23 Sept 2026',
    );
  });

  it('stableKey is independent of key order', () => {
    expect(stableKey({ b: 1, a: { d: 2, c: 3 } })).toBe(stableKey({ a: { c: 3, d: 2 }, b: 1 }));
  });
});
