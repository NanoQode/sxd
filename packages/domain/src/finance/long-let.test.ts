import { describe, expect, it } from 'vitest';
import type { LongLetInput } from './long-let';
import { longLetEconomics, MANAGEMENT_FEE_DOUBLE_CHARGE } from './long-let';
import type { Result } from './result';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
  return result.value;
}

function failure<T>(result: Result<T>): { reason: string; missing?: string[] } {
  if (result.ok) throw new Error('expected a failure, got ok');
  return result;
}

/**
 * The brief's own unit-test example (§6.4), entirely hypothetical: 2 units at
 * NGN 3m/year, 10% vacancy, zero collection loss, NGN 1.2m annual operating
 * expenses and NGN 100m total cost. These are test assumptions, not seeded
 * city prices.
 */
const specExample: LongLetInput = {
  unitGroups: [{ label: 'flats', units: 2, annualRentPerUnit: 3_000_000 }],
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
};

describe('longLetEconomics', () => {
  it('reproduces the specification example: 6m scheduled, 5.4m effective, 4.2m NOI, 6% gross, 4.2% net', () => {
    const economics = unwrap(longLetEconomics(specExample));
    expect(economics.kind).toBe('long_let');
    expect(economics.scheduledAnnualRent).toBe(6_000_000);
    expect(economics.vacancyLoss).toBeCloseTo(600_000, 6);
    expect(economics.effectiveIncome).toBeCloseTo(5_400_000, 6);
    expect(economics.operatingExpenses.total).toBe(1_200_000);
    expect(economics.noi).toBeCloseTo(4_200_000, 6);
    expect(unwrap(economics.grossYieldPercent)).toBeCloseTo(6, 10);
    expect(unwrap(economics.netYieldPercent)).toBeCloseTo(4.2, 10);
    expect(economics.denominator).toEqual({ kind: 'development_cost', amount: 100_000_000 });
  });

  it('sums units × rent across unit groups and applies collection loss after vacancy', () => {
    const economics = unwrap(
      longLetEconomics({
        ...specExample,
        unitGroups: [
          { units: 2, annualRentPerUnit: 3_000_000 },
          { units: 4, annualRentPerUnit: 1_500_000 },
        ],
        collectionLossRate: 0.05,
        otherAnnualIncome: 100_000,
      }),
    );
    expect(economics.scheduledAnnualRent).toBe(12_000_000);
    expect(economics.vacancyLoss).toBeCloseTo(1_200_000, 6);
    expect(economics.collectionLoss).toBeCloseTo(540_000, 6);
    expect(economics.effectiveRentalIncome).toBeCloseTo(10_260_000, 6);
    expect(economics.effectiveIncome).toBeCloseTo(10_360_000, 6);
  });

  it('charges a fractional management fee on effective income', () => {
    const economics = unwrap(
      longLetEconomics({
        ...specExample,
        operatingExpenses: {
          ...specExample.operatingExpenses,
          managementFee: { fractionOfEffectiveIncome: 0.1 },
        },
      }),
    );
    expect(economics.operatingExpenses.managementFeeBasis).toBe('fraction_of_effective_income');
    expect(economics.operatingExpenses.managementFee).toBeCloseTo(540_000, 6);
    expect(economics.operatingExpenses.total).toBeCloseTo(1_740_000, 6);
    expect(economics.noi).toBeCloseTo(3_660_000, 6);
  });

  it('rejects a management fee supplied both as a fraction and as a fixed amount', () => {
    const rejected = failure(
      longLetEconomics({
        ...specExample,
        operatingExpenses: {
          ...specExample.operatingExpenses,
          managementFee: { fractionOfEffectiveIncome: 0.1, fixedAmount: 300_000 },
        },
      }),
    );
    expect(rejected.reason).toContain(MANAGEMENT_FEE_DOUBLE_CHARGE);
    expect(rejected.reason).toMatch(/not charged twice/);
  });

  it('requires an explicit management fee rather than assuming none', () => {
    const rejected = failure(
      longLetEconomics({
        ...specExample,
        operatingExpenses: { ...specExample.operatingExpenses, managementFee: {} },
      }),
    );
    expect(rejected.missing).toEqual([
      'operatingExpenses.managementFee.fractionOfEffectiveIncome or operatingExpenses.managementFee.fixedAmount',
    ]);
  });

  it('reports no yield when the cost denominator is zero but still computes NOI', () => {
    const economics = unwrap(
      longLetEconomics({ ...specExample, denominator: { kind: 'development_cost', amount: 0 } }),
    );
    expect(economics.noi).toBeCloseTo(4_200_000, 6);
    expect(failure(economics.grossYieldPercent).reason).toMatch(
      /development cost denominator is zero/,
    );
    expect(failure(economics.netYieldPercent).reason).toMatch(/No yield/);
    expect(failure(economics.simplePaybackYears).reason).toMatch(/denominator is zero/);
  });

  it('keeps debt service out of NOI and net yield, but in cash flow after debt', () => {
    const economics = unwrap(longLetEconomics({ ...specExample, annualDebtService: 1_000_000 }));
    expect(economics.noi).toBeCloseTo(4_200_000, 6);
    expect(unwrap(economics.netYieldPercent)).toBeCloseTo(4.2, 10);
    expect(economics.cashFlowAfterDebt).toBeCloseTo(3_200_000, 6);
  });

  it('leaves simple payback undefined when net cash flow after debt is not positive', () => {
    const payback = unwrap(longLetEconomics(specExample)).simplePaybackYears;
    expect(unwrap(payback)).toBeCloseTo(100_000_000 / 4_200_000, 10);

    const overGeared = unwrap(longLetEconomics({ ...specExample, annualDebtService: 5_000_000 }));
    expect(overGeared.cashFlowAfterDebt).toBeCloseTo(-800_000, 6);
    expect(failure(overGeared.simplePaybackYears).reason).toMatch(/not positive/);

    const breakEven = unwrap(longLetEconomics({ ...specExample, annualDebtService: 4_200_000 }));
    expect(breakEven.simplePaybackYears.ok).toBe(false);
  });

  it('computes cash-on-cash only with an explicit equity denominator', () => {
    const noEquity = unwrap(longLetEconomics({ ...specExample, annualDebtService: 1_000_000 }));
    expect(noEquity.equity).toBeNull();
    expect(failure(noEquity.cashOnCashPercent).missing).toEqual(['equity']);

    const withEquity = unwrap(
      longLetEconomics({ ...specExample, annualDebtService: 1_000_000, equity: 40_000_000 }),
    );
    expect(unwrap(withEquity.cashOnCashPercent)).toBeCloseTo(8, 10);
    expect(failure(longLetEconomics({ ...specExample, equity: 0 })).reason).toMatch(
      /equity must be .* greater than zero/,
    );
  });

  it('reports the capex reserve separately unless the caller asks to include it in NOI', () => {
    const separate = unwrap(longLetEconomics({ ...specExample, capexReserve: 300_000 }));
    expect(separate.capexReserve).toBe(300_000);
    expect(separate.capexReserveTreatment).toBe('reported_separately');
    expect(separate.noiAfterCapexReserve).toBeNull();
    expect(separate.noiBasis).toBe('noi');
    expect(unwrap(separate.netYieldPercent)).toBeCloseTo(4.2, 10);
    expect(separate.cashFlowAfterDebt).toBeCloseTo(4_200_000, 6);

    const included = unwrap(
      longLetEconomics({ ...specExample, capexReserve: 300_000, includeCapexReserveInNoi: true }),
    );
    expect(included.noi).toBeCloseTo(4_200_000, 6);
    expect(included.noiAfterCapexReserve).toBeCloseTo(3_900_000, 6);
    expect(included.capexReserveTreatment).toBe('included_in_noi');
    expect(included.noiBasis).toBe('noi_after_capex_reserve');
    expect(unwrap(included.netYieldPercent)).toBeCloseTo(3.9, 10);
    expect(included.cashFlowAfterDebt).toBeCloseTo(3_900_000, 6);
  });

  it('distinguishes pre-tax and after-tax outputs using the supplied tax assumption', () => {
    const taxed = unwrap(
      longLetEconomics({
        ...specExample,
        tax: { kind: 'fraction_of_noi', value: 0.3 },
        annualDebtService: 1_000_000,
        equity: 40_000_000,
      }),
    );
    expect(taxed.tax).toEqual({
      assumption: { kind: 'fraction_of_noi', value: 0.3 },
      amount: 1_260_000,
    });
    expect(taxed.noi).toBeCloseTo(4_200_000, 6);
    expect(taxed.noiAfterTax).toBeCloseTo(2_940_000, 6);
    expect(taxed.cashFlowAfterDebt).toBeCloseTo(3_200_000, 6);
    expect(taxed.cashFlowAfterDebtAfterTax).toBeCloseTo(1_940_000, 6);
    expect(unwrap(taxed.cashOnCashPercent)).toBeCloseTo(8, 10);
    expect(unwrap(taxed.cashOnCashAfterTaxPercent)).toBeCloseTo(4.85, 10);

    const fixed = unwrap(
      longLetEconomics({ ...specExample, tax: { kind: 'fixed', value: 250_000 } }),
    );
    expect(fixed.tax.amount).toBe(250_000);
    expect(fixed.noiAfterTax).toBeCloseTo(3_950_000, 6);
  });

  it('never turns a loss into a tax credit', () => {
    const loss = unwrap(
      longLetEconomics({
        ...specExample,
        unitGroups: [{ units: 2, annualRentPerUnit: 500_000 }],
        tax: { kind: 'fraction_of_noi', value: 0.3 },
      }),
    );
    expect(loss.noi).toBeLessThan(0);
    expect(loss.tax.amount).toBe(0);
  });

  it('echoes an acquisition-basis denominator for purchase scenarios', () => {
    const purchase = unwrap(
      longLetEconomics({
        ...specExample,
        denominator: { kind: 'acquisition_basis', amount: 84_000_000 },
      }),
    );
    expect(purchase.denominator.kind).toBe('acquisition_basis');
    expect(unwrap(purchase.netYieldPercent)).toBeCloseTo(5, 10);
  });

  it('names missing inputs and rejects out-of-range rates instead of defaulting', () => {
    const missing = failure(
      longLetEconomics({
        unitGroups: [{ units: 2, annualRentPerUnit: 3_000_000 }],
      } as unknown as LongLetInput),
    );
    expect(missing.missing).toEqual([
      'vacancyRate',
      'collectionLossRate',
      'otherAnnualIncome',
      'operatingExpenses',
      'tax',
      'capexReserve',
      'annualDebtService',
      'denominator',
    ]);
    expect(failure(longLetEconomics({ ...specExample, vacancyRate: 1.5 })).reason).toMatch(
      /vacancyRate must be a fraction between 0 and 1/,
    );
    expect(
      failure(
        longLetEconomics({ ...specExample, unitGroups: [{ units: 1.5, annualRentPerUnit: 1 }] }),
      ).reason,
    ).toMatch(/unitGroups\[0\].units must be a whole number/);
    expect(failure(longLetEconomics({ ...specExample, unitGroups: [] })).reason).toMatch(
      /at least one unit group/,
    );
  });
});
