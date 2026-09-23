import type { Result } from './result';
import { fail, InputCheck, isPresent, ok } from './result';

export type RepaymentType = 'annuity' | 'interest_only';

/** Loan terms for deriving annual debt service. Every field is explicit. */
export interface LoanTerms {
  /** Whole naira. */
  principal: number;
  /** Nominal annual rate as a fraction (0.24 = 24%). */
  annualInterestRate: number;
  termYears: number;
  repayment: RepaymentType;
  /** Payments per year (12 = monthly, 4 = quarterly, 1 = annual). */
  paymentsPerYear: number;
}

export interface DebtService {
  /** `paymentPerPeriod * paymentsPerYear`. */
  annualDebtService: number;
  paymentPerPeriod: number;
  paymentsPerYear: number;
  periods: number;
  ratePerPeriod: number;
  repayment: RepaymentType;
}

/**
 * Annual debt service from loan terms: a level annuity payment
 * `P * i / (1 - (1 + i)^-n)` (or `P / n` at a zero rate), or interest only.
 */
export function annualDebtService(loan: LoanTerms | null | undefined): Result<DebtService> {
  if (!isPresent(loan)) {
    return fail('Loan terms are required to derive debt service.', [
      'loan.principal',
      'loan.annualInterestRate',
      'loan.termYears',
      'loan.repayment',
      'loan.paymentsPerYear',
    ]);
  }
  const check = new InputCheck();
  const principal = check.amount('loan.principal', loan.principal);
  const annualRate = check.amount('loan.annualInterestRate', loan.annualInterestRate);
  const termYears = check.positive('loan.termYears', loan.termYears);
  const paymentsPerYear = check.integer('loan.paymentsPerYear', loan.paymentsPerYear, 1);
  const repayment: unknown = loan.repayment;
  if (repayment !== 'annuity' && repayment !== 'interest_only') {
    if (isPresent(repayment)) check.problem("loan.repayment must be 'annuity' or 'interest_only'");
    else check.absent('loan.repayment');
  }
  if (check.failed || (repayment !== 'annuity' && repayment !== 'interest_only')) {
    return check.failure();
  }

  const periods = termYears * paymentsPerYear;
  const ratePerPeriod = annualRate / paymentsPerYear;
  let paymentPerPeriod: number;
  if (repayment === 'interest_only') {
    paymentPerPeriod = principal * ratePerPeriod;
  } else if (ratePerPeriod === 0) {
    paymentPerPeriod = principal / periods;
  } else {
    paymentPerPeriod = (principal * ratePerPeriod) / (1 - (1 + ratePerPeriod) ** -periods);
  }
  return ok({
    annualDebtService: paymentPerPeriod * paymentsPerYear,
    paymentPerPeriod,
    paymentsPerYear,
    periods,
    ratePerPeriod,
    repayment,
  });
}
