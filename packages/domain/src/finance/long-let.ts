import type { CostDenominator } from './denominator';
import { checkDenominator, yieldPercent } from './denominator';
import type { Result } from './result';
import { fail, InputCheck, isPresent, ok } from './result';

export interface UnitGroup {
  /** Optional label, e.g. "3-bed flats". */
  label?: string;
  /** Number of lettable units in the group (whole number). */
  units: number;
  /** Scheduled annual rent per unit, whole naira. */
  annualRentPerUnit: number;
}

/**
 * Management fee as EITHER a fraction of effective income OR a fixed annual
 * amount. Brief §6.4: "Prevent charging a management percentage twice" —
 * supplying both is rejected. "No fee" is expressed explicitly as
 * `{ fixedAmount: 0 }`.
 */
export interface ManagementFeeInput {
  fractionOfEffectiveIncome?: number | null;
  fixedAmount?: number | null;
}

/**
 * Recurring operating expenses, itemised. Debt service and the capex reserve
 * are deliberately not here: "Debt service is not an NOI expense" and the
 * reserve is reported separately (see `includeCapexReserveInNoi`).
 */
export interface OperatingExpensesInput {
  managementFee: ManagementFeeInput;
  maintenance: number;
  insurance: number;
  serviceCosts: number;
  unrecoverableCharges: number;
}

/**
 * Tax assumption supplied and reviewed by the business; the calculator never
 * chooses a rate. `fraction_of_noi` applies to NOI as defined below (before
 * any capex reserve) and never goes negative: a loss produces zero tax, not a
 * credit.
 */
export type TaxAssumption =
  { kind: 'none' } | { kind: 'fraction_of_noi'; value: number } | { kind: 'fixed'; value: number };

export interface LongLetInput {
  unitGroups: UnitGroup[];
  /** Fraction of scheduled rent lost to vacancy (0.1 = 10%). */
  vacancyRate: number;
  /** Fraction of post-vacancy rent lost to non-collection (0 = none). */
  collectionLossRate: number;
  /** Other annual income (car parks, signage, service charge margin…), whole naira. Pass 0 when none. */
  otherAnnualIncome: number;
  operatingExpenses: OperatingExpensesInput;
  tax: TaxAssumption;
  /** Annual capital expenditure reserve, whole naira. Pass 0 when none. */
  capexReserve: number;
  /**
   * When true, `noiAfterCapexReserve` is produced and becomes the NOI basis
   * for net yield, cash flow after debt and payback (`noiBasis` says so).
   * When false (default) the reserve is only reported separately.
   */
  includeCapexReserveInNoi?: boolean;
  /** Annual debt service (principal + interest), whole naira. Pass 0 when unlevered. */
  annualDebtService: number;
  /** What yields divide by; the kind is echoed in the result. */
  denominator: CostDenominator;
  /** Equity invested, whole naira. Cash-on-cash is only computed when this is supplied. */
  equity?: number | null;
}

export type ManagementFeeBasis = 'fraction_of_effective_income' | 'fixed';

export interface OperatingExpensesBreakdown {
  managementFee: number;
  managementFeeBasis: ManagementFeeBasis;
  maintenance: number;
  insurance: number;
  serviceCosts: number;
  unrecoverableCharges: number;
  total: number;
}

export type CapexReserveTreatment = 'reported_separately' | 'included_in_noi';
export type NoiBasis = 'noi' | 'noi_after_capex_reserve';

/**
 * Annual long-let economics. Distinct from `ShortStayEconomics` (brief §6.4:
 * "Keep short-stay cohorts separate from annual leases"); the `kind`
 * discriminant makes mixing the two a type error.
 */
export interface LongLetEconomics {
  kind: 'long_let';
  /** `sum(units * annual_rent_per_unit)`. */
  scheduledAnnualRent: number;
  vacancyLoss: number;
  collectionLoss: number;
  /** `scheduled_annual_rent * (1 - vacancy_rate) * (1 - collection_loss_rate)`. */
  effectiveRentalIncome: number;
  otherAnnualIncome: number;
  /** `effectiveRentalIncome + other_annual_income`. */
  effectiveIncome: number;
  operatingExpenses: OperatingExpensesBreakdown;
  /** `effective_income - recurring_operating_expenses`; pre-tax, before capex reserve, before debt. */
  noi: number;
  /** Always reported, never silently netted into `noi`. */
  capexReserve: number;
  capexReserveTreatment: CapexReserveTreatment;
  /** `noi - capexReserve`, only when `includeCapexReserveInNoi` was true. */
  noiAfterCapexReserve: number | null;
  /** Which NOI figure feeds net yield, cash flow after debt and payback. */
  noiBasis: NoiBasis;
  tax: { assumption: TaxAssumption; amount: number };
  /** `noi - tax`. */
  noiAfterTax: number;
  annualDebtService: number;
  /** `NOI basis - annual_debt_service`, pre-tax. */
  cashFlowAfterDebt: number;
  /** `cashFlowAfterDebt - tax`. */
  cashFlowAfterDebtAfterTax: number;
  denominator: CostDenominator;
  /** `scheduled_annual_rent / denominator * 100`. */
  grossYieldPercent: Result<number>;
  /** `NOI basis / denominator * 100`. */
  netYieldPercent: Result<number>;
  equity: number | null;
  /** `cashFlowAfterDebt / equity * 100`; only with an explicit equity denominator. */
  cashOnCashPercent: Result<number>;
  /** `cashFlowAfterDebtAfterTax / equity * 100`. */
  cashOnCashAfterTaxPercent: Result<number>;
  /** `denominator / cashFlowAfterDebt` in years; undefined when that cash flow is not positive. */
  simplePaybackYears: Result<number>;
}

export const MANAGEMENT_FEE_DOUBLE_CHARGE =
  'operatingExpenses.managementFee was supplied both as a fraction of effective income and as a ' +
  'fixed amount; supply exactly one so the fee is not charged twice';

function checkTax(check: InputCheck, tax: TaxAssumption): void {
  switch (tax.kind) {
    case 'none':
      return;
    case 'fraction_of_noi':
      check.fraction('tax.value', tax.value);
      return;
    case 'fixed':
      check.amount('tax.value', tax.value);
      return;
    default:
      check.problem(
        `tax.kind must be 'none', 'fraction_of_noi' or 'fixed' (got ${String(
          (tax as { kind?: unknown }).kind,
        )})`,
      );
  }
}

function taxAmount(tax: TaxAssumption, noi: number): number {
  switch (tax.kind) {
    case 'none':
      return 0;
    case 'fraction_of_noi':
      return Math.max(noi, 0) * tax.value;
    case 'fixed':
      return tax.value;
  }
}

/**
 * Long-let rental economics per brief §6.4:
 *
 *   scheduled_annual_rent = sum(units * annual_rent_per_unit)
 *   effective_income      = scheduled_annual_rent*(1-vacancy_rate)*(1-collection_loss_rate) + other_annual_income
 *   NOI                   = effective_income - recurring_operating_expenses
 *   gross_yield           = scheduled_annual_rent/total_development_cost*100
 *   net_yield             = NOI/total_development_cost*100
 *   cash_flow_after_debt  = NOI - annual_debt_service
 *
 * Whole-naira scenario arithmetic as JavaScript numbers: estimates, not
 * ledger money. Nothing is defaulted; absent inputs fail with `missing`.
 */
export function longLetEconomics(input: LongLetInput | null | undefined): Result<LongLetEconomics> {
  if (!isPresent(input)) return fail('Long-let inputs are required.', ['longLet']);
  const check = new InputCheck();

  let scheduledAnnualRent = 0;
  if (!Array.isArray(input.unitGroups)) {
    check.absent('unitGroups');
  } else if (input.unitGroups.length === 0) {
    check.problem('unitGroups must contain at least one unit group');
  } else {
    input.unitGroups.forEach((group, i) => {
      const units = check.integer(`unitGroups[${i}].units`, group?.units, 0);
      const rent = check.amount(`unitGroups[${i}].annualRentPerUnit`, group?.annualRentPerUnit);
      if (Number.isFinite(units) && Number.isFinite(rent)) scheduledAnnualRent += units * rent;
    });
  }
  const vacancyRate = check.fraction('vacancyRate', input.vacancyRate);
  const collectionLossRate = check.fraction('collectionLossRate', input.collectionLossRate);
  const otherAnnualIncome = check.amount('otherAnnualIncome', input.otherAnnualIncome);

  const opex = input.operatingExpenses;
  let managementFraction: number | null = null;
  let managementFixed: number | null = null;
  let maintenance = Number.NaN;
  let insurance = Number.NaN;
  let serviceCosts = Number.NaN;
  let unrecoverableCharges = Number.NaN;
  if (!isPresent(opex)) {
    check.absent('operatingExpenses');
  } else {
    maintenance = check.amount('operatingExpenses.maintenance', opex.maintenance);
    insurance = check.amount('operatingExpenses.insurance', opex.insurance);
    serviceCosts = check.amount('operatingExpenses.serviceCosts', opex.serviceCosts);
    unrecoverableCharges = check.amount(
      'operatingExpenses.unrecoverableCharges',
      opex.unrecoverableCharges,
    );
    const fee = opex.managementFee;
    if (!isPresent(fee)) {
      check.absent('operatingExpenses.managementFee');
    } else {
      const hasFraction = isPresent(fee.fractionOfEffectiveIncome);
      const hasFixed = isPresent(fee.fixedAmount);
      if (hasFraction && hasFixed) {
        check.problem(MANAGEMENT_FEE_DOUBLE_CHARGE);
      } else if (hasFraction) {
        managementFraction = check.fraction(
          'operatingExpenses.managementFee.fractionOfEffectiveIncome',
          fee.fractionOfEffectiveIncome,
        );
      } else if (hasFixed) {
        managementFixed = check.amount(
          'operatingExpenses.managementFee.fixedAmount',
          fee.fixedAmount,
        );
      } else {
        check.absent(
          'operatingExpenses.managementFee.fractionOfEffectiveIncome or operatingExpenses.managementFee.fixedAmount',
        );
      }
    }
  }

  const tax = input.tax;
  if (!isPresent(tax)) check.absent('tax');
  else checkTax(check, tax);
  const capexReserve = check.amount('capexReserve', input.capexReserve);
  const annualDebtService = check.amount('annualDebtService', input.annualDebtService);
  const denominator = checkDenominator(check, 'denominator', input.denominator);
  const equity = isPresent(input.equity) ? check.positive('equity', input.equity) : null;
  if (check.failed || denominator === null || !isPresent(tax)) return check.failure();

  const vacancyLoss = scheduledAnnualRent * vacancyRate;
  const afterVacancy = scheduledAnnualRent - vacancyLoss;
  const collectionLoss = afterVacancy * collectionLossRate;
  const effectiveRentalIncome = afterVacancy - collectionLoss;
  const effectiveIncome = effectiveRentalIncome + otherAnnualIncome;

  const managementFee =
    managementFraction !== null ? effectiveIncome * managementFraction : (managementFixed ?? 0);
  const operatingExpenses: OperatingExpensesBreakdown = {
    managementFee,
    managementFeeBasis: managementFraction !== null ? 'fraction_of_effective_income' : 'fixed',
    maintenance,
    insurance,
    serviceCosts,
    unrecoverableCharges,
    total: managementFee + maintenance + insurance + serviceCosts + unrecoverableCharges,
  };

  const noi = effectiveIncome - operatingExpenses.total;
  const taxDue = taxAmount(tax, noi);
  const includeReserve = input.includeCapexReserveInNoi === true;
  const noiAfterCapexReserve = includeReserve ? noi - capexReserve : null;
  const noiBasisAmount = noiAfterCapexReserve ?? noi;
  const cashFlowAfterDebt = noiBasisAmount - annualDebtService;
  const cashFlowAfterDebtAfterTax = cashFlowAfterDebt - taxDue;

  const cashOnCash = (cashFlow: number): Result<number> =>
    equity === null
      ? fail('Cash-on-cash return requires an explicit equity denominator.', ['equity'])
      : ok((cashFlow / equity) * 100);

  let simplePaybackYears: Result<number>;
  if (!(cashFlowAfterDebt > 0)) {
    simplePaybackYears = fail(
      'Simple payback is undefined: annual net cash flow after debt service is not positive.',
    );
  } else if (!(denominator.amount > 0)) {
    simplePaybackYears = fail('Simple payback is undefined: the cost denominator is zero.');
  } else {
    simplePaybackYears = ok(denominator.amount / cashFlowAfterDebt);
  }

  return ok({
    kind: 'long_let',
    scheduledAnnualRent,
    vacancyLoss,
    collectionLoss,
    effectiveRentalIncome,
    otherAnnualIncome,
    effectiveIncome,
    operatingExpenses,
    noi,
    capexReserve,
    capexReserveTreatment: includeReserve ? 'included_in_noi' : 'reported_separately',
    noiAfterCapexReserve,
    noiBasis: includeReserve ? 'noi_after_capex_reserve' : 'noi',
    tax: { assumption: tax, amount: taxDue },
    noiAfterTax: noi - taxDue,
    annualDebtService,
    cashFlowAfterDebt,
    cashFlowAfterDebtAfterTax,
    denominator,
    grossYieldPercent: yieldPercent(scheduledAnnualRent, denominator),
    netYieldPercent: yieldPercent(noiBasisAmount, denominator),
    equity,
    cashOnCashPercent: cashOnCash(cashFlowAfterDebt),
    cashOnCashAfterTaxPercent: cashOnCash(cashFlowAfterDebtAfterTax),
    simplePaybackYears,
  });
}
