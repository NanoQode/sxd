import { describe, expect, it } from 'vitest';
import type { LoanTerms } from './loan';
import { annualDebtService } from './loan';
import type { Result } from './result';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
  return result.value;
}

function failure<T>(result: Result<T>): { reason: string; missing?: string[] } {
  if (result.ok) throw new Error('expected a failure, got ok');
  return result;
}

/** Hypothetical loan: NGN 1m at 10% over 10 years, one payment a year. */
const annual: LoanTerms = {
  principal: 1_000_000,
  annualInterestRate: 0.1,
  termYears: 10,
  repayment: 'annuity',
  paymentsPerYear: 1,
};

describe('annualDebtService', () => {
  it('computes a level annuity payment', () => {
    const debt = unwrap(annualDebtService(annual));
    expect(debt.annualDebtService).toBeCloseTo(162_745.39, 2);
    expect(debt.periods).toBe(10);
    expect(debt.ratePerPeriod).toBe(0.1);
  });

  it('computes interest-only and zero-rate cases', () => {
    expect(
      unwrap(annualDebtService({ ...annual, repayment: 'interest_only' })).annualDebtService,
    ).toBe(100_000);
    expect(unwrap(annualDebtService({ ...annual, annualInterestRate: 0 })).annualDebtService).toBe(
      100_000,
    );
  });

  it('handles monthly payments by dividing the nominal rate', () => {
    const debt = unwrap(
      annualDebtService({
        principal: 1_000_000,
        annualInterestRate: 0.12,
        termYears: 1,
        repayment: 'annuity',
        paymentsPerYear: 12,
      }),
    );
    expect(debt.paymentPerPeriod).toBeCloseTo(88_848.79, 2);
    expect(debt.annualDebtService).toBeCloseTo(1_066_185.46, 2);
  });

  it('names missing terms and rejects unknown repayment types', () => {
    expect(failure(annualDebtService(undefined)).missing).toEqual([
      'loan.principal',
      'loan.annualInterestRate',
      'loan.termYears',
      'loan.repayment',
      'loan.paymentsPerYear',
    ]);
    expect(
      failure(annualDebtService({ ...annual, principal: undefined } as unknown as LoanTerms))
        .missing,
    ).toEqual(['loan.principal']);
    expect(
      failure(annualDebtService({ ...annual, repayment: 'bullet' } as unknown as LoanTerms)).reason,
    ).toMatch(/loan.repayment must be 'annuity' or 'interest_only'/);
  });
});
