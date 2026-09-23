import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString as renderRaw } from 'react-dom/server';
import type { ReactElement } from 'react';

/** SSR inserts comment markers between adjacent text nodes; strip them for substring assertions. */
const renderToString = (element: ReactElement): string =>
  renderRaw(element).replace(/<!-- -->/g, '');
import { COPY, normalizeCalculatorResponse } from '@/lib/explorer';
import { CalculatorResults, LongLetTable } from './calculator-results';

const longLet = {
  scheduledAnnualRent: 6_000_000,
  effectiveIncome: 5_400_000,
  operatingExpenses: { total: 1_200_000 },
  noi: 4_200_000,
  annualDebtService: 5_000_000,
  cashFlowAfterDebt: -800_000,
  denominator: { kind: 'development_cost', amount: 100_000_000 },
  grossYieldPercent: { ok: true, value: 6 },
  netYieldPercent: { ok: true, value: 4.2 },
  simplePaybackYears: {
    ok: false,
    reason: 'Simple payback is undefined: annual net cash flow after debt service is not positive.',
  },
};

describe('calculator results', () => {
  it('renders the brief worked example with the denominator label and an undefined payback', () => {
    const result = normalizeCalculatorResponse({ longLet: { ok: true, value: longLet } });
    const html = renderToString(
      createElement(LongLetTable, { sets: result.sets, base: result.longLet }),
    );
    expect(html).toContain('₦6,000,000');
    expect(html).toContain('₦5,400,000');
    expect(html).toContain('₦4,200,000');
    expect(html).toContain('6.00%');
    expect(html).toContain('4.20%');
    expect(html).toContain('denominator: development cost');
    expect(html).toContain('Simple payback is undefined');
    expect(html).toContain('-₦800,000');
  });

  it('lists what is missing instead of estimating when inputs are absent', () => {
    const html = renderToString(
      createElement(CalculatorResults, {
        result: null,
        loading: false,
        error: null,
        usable: false,
        missing: ['land cost'],
        showNpv: false,
      }),
    );
    expect(html).toContain('no Nigerian averages are assumed');
    expect(html).toContain('land cost');
    expect(html).not.toContain('₦');
  });

  it('shows failure reasons per set and the scenario disclaimer', () => {
    const result = normalizeCalculatorResponse({
      developmentCost: { ok: false, reason: 'Missing required inputs: land.', missing: ['land'] },
      longLet: { ok: true, value: longLet },
      scenarioSets: {
        low: { ok: false, reason: 'low set invalid' },
        base: { ok: true, value: longLet },
        high: { ok: true, value: longLet },
      },
      sensitivity: { ok: false, reason: 'no base' },
    });
    const html = renderToString(
      createElement(CalculatorResults, {
        result,
        loading: false,
        error: null,
        usable: true,
        missing: [],
        showNpv: false,
      }),
    );
    expect(html).toContain('Development cost not computed');
    expect(html).toContain('Not computed: low set invalid');
    expect(html).toContain('Sensitivity not computed: no base');
    expect(html).toContain(COPY.scenarioDisclaimer);
  });
});
