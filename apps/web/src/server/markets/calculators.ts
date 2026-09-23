import type {
  CalculatorResultDto,
  CalculatorRunRequest,
  CalculatorRunResponse,
  CalculatorSetResultDto,
  InputSet,
  Objective,
  ScenarioAssumptions,
} from '@simplexd/contracts';
import {
  developmentCost,
  irr,
  longLetEconomics,
  monthlyPhasing,
  npv,
  sensitivityGrid,
  shortStayEconomics,
  fail,
  type CostDenominator,
  type DatedCashFlow,
  type DevelopmentCost,
  type DevelopmentCostInput,
  type ExitAssumption,
  type LongLetEconomics,
  type LongLetInput,
  type MonthlyPhasing,
  type Result,
  type ShortStayEconomics,
  type ShortStayInput,
} from '@simplexd/domain/finance';

/**
 * Calculator orchestration for the API: maps the wire `InputSet` onto the
 * pure finance calculators and echoes every `ok: false` reason instead of
 * substituting a default. Nothing here persists anything.
 */

export const CALCULATOR_DISCLAIMER =
  'Scenarios are not valuations or investment advice. Every figure is computed only from the ' +
  'assumptions you supplied under a stated formula; inputs that are absent are reported as missing, ' +
  'never replaced by a Nigerian average.';

export type EconomicsKind = 'long_let' | 'short_stay';

/** Short stays use the short-stay model; every other objective uses annual leases. Never mixed. */
export function economicsKindFor(objective: Objective): EconomicsKind {
  return objective === 'short_stay' ? 'short_stay' : 'long_let';
}

/** Low/high sets are shallow overrides on the base set. */
export function mergeInputSet(base: InputSet, overrides: Partial<InputSet> | null): InputSet {
  if (!overrides) return base;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as InputSet;
}

/**
 * Scope assumed for a build rate entered on the wire. The area-rate figure is
 * taken to cover roof and finishes; external works are entered separately in
 * `utilitiesAndExternalWorksNaira`, so they are excluded from the rate.
 */
export const BUILD_RATE_INCLUSIONS = {
  roof: true,
  finishes: true,
  externalWorks: false,
  notes:
    'Assumed scope of the entered build rate: roof and finishes included; external works are entered separately as utilities and external works.',
} as const;

export function toDevelopmentCostInput(set: InputSet): DevelopmentCostInput {
  const areaRate =
    set.grossFloorAreaM2 !== null && set.buildRateNairaPerM2 !== null
      ? {
          grossFloorArea: { value: set.grossFloorAreaM2, unit: 'm2' as const },
          approvedBuildRateNgnPerM2: set.buildRateNairaPerM2,
        }
      : null;
  const boq = set.boqTotalNaira !== null ? { totalNgn: set.boqTotalNaira } : null;
  return {
    // A null land cost is passed through as missing: the calculator names it, we never assume it.
    land: set.landCostNaira as number,
    acquisitionCosts: set.acquisitionCostsNaira,
    build: { areaRate, boq, inclusions: { ...BUILD_RATE_INCLUSIONS } },
    professionalFees: set.professionalFeesNaira,
    approvals: set.approvalsNaira,
    utilitiesAndExternalWorks: set.utilitiesAndExternalWorksNaira,
    contingency: { kind: 'fraction_of_build_and_fees', fraction: set.contingencyFraction },
    financingDuringBuild: set.financingDuringBuildNaira,
  };
}

type LongLetInputMaybeDenominator = Omit<LongLetInput, 'denominator'> & {
  denominator: CostDenominator | null;
};

export function toLongLetInput(
  set: InputSet,
  denominator: CostDenominator | null,
): LongLetInputMaybeDenominator {
  const { managementFeeFraction, managementFeeFixedNaira } = set.opex;
  const managementFee =
    managementFeeFraction === null && managementFeeFixedNaira === null
      ? { fixedAmount: 0 }
      : { fractionOfEffectiveIncome: managementFeeFraction, fixedAmount: managementFeeFixedNaira };
  return {
    unitGroups: set.units.map((group) => ({
      label: group.label,
      units: group.count,
      annualRentPerUnit: group.annualRentPerUnitNaira,
    })),
    vacancyRate: set.vacancyRate,
    collectionLossRate: set.collectionLossRate,
    otherAnnualIncome: set.otherAnnualIncomeNaira,
    operatingExpenses: {
      managementFee,
      maintenance: set.opex.maintenanceNaira,
      insurance: set.opex.insuranceNaira,
      serviceCosts: set.opex.serviceCostsNaira,
      unrecoverableCharges: set.opex.unrecoverableChargesNaira,
    },
    tax: set.tax,
    capexReserve: set.capexReserveNaira,
    annualDebtService: set.annualDebtServiceNaira,
    denominator,
    equity: set.equityNaira,
  };
}

export function toShortStayInput(
  set: InputSet,
  denominator: CostDenominator | null,
): ShortStayInput | null {
  const s = set.shortStay;
  if (!s) return null;
  return {
    availableNightsPerYear: s.availableNightsPerYear,
    occupiedNightFraction: s.occupiedNightFraction,
    nightlyRate: s.nightlyRateNaira,
    platformChargeFraction: s.platformChargeFraction,
    cleaningCostPerStay: s.cleaningCostPerStayNaira,
    stays: { averageLengthOfStayNights: s.averageLengthOfStayNights },
    annualOperatingCosts: s.operatingCostsNaira,
    denominator,
  };
}

/** The finance `Result` already has the wire shape; this only narrows the type. */
function toDto<T>(result: Result<T>): CalculatorResultDto {
  return result.ok ? { ok: true, value: result.value } : result;
}

function runLongLet(input: LongLetInputMaybeDenominator): Result<LongLetEconomics> {
  // The calculator validates the denominator at runtime and names it when absent.
  return longLetEconomics(input as LongLetInput);
}

function runShortStay(input: ShortStayInput | null): Result<ShortStayEconomics> {
  if (!input) {
    return fail('Short-stay inputs are required for a short-stay scenario.', ['shortStay']);
  }
  return shortStayEconomics(input);
}

interface OperatingFigures {
  annualIncome: number;
  annualOperatingExpenses: number;
  netYieldPercent: number | null;
}

function operatingFigures(
  kind: EconomicsKind,
  longLet: Result<LongLetEconomics> | null,
  shortStay: Result<ShortStayEconomics> | null,
): OperatingFigures | null {
  if (kind === 'long_let') {
    if (!longLet?.ok) return null;
    const e = longLet.value;
    return {
      annualIncome: e.effectiveIncome,
      annualOperatingExpenses: e.operatingExpenses.total,
      netYieldPercent: e.netYieldPercent.ok ? e.netYieldPercent.value : null,
    };
  }
  if (!shortStay?.ok) return null;
  const e = shortStay.value;
  return {
    annualIncome: e.netBookingRevenue,
    annualOperatingExpenses: e.cleaningCosts + e.annualOperatingCosts,
    netYieldPercent: e.netYieldPercent.ok ? e.netYieldPercent.value : null,
  };
}

function runPhasing(
  set: InputSet,
  cost: Result<DevelopmentCost>,
  figures: OperatingFigures | null,
  asOf: Date,
): Result<MonthlyPhasing> {
  if (!cost.ok)
    return fail(`Phasing needs the development cost first: ${cost.reason}`, cost.missing);
  if (!figures) {
    return fail(
      'Phasing needs the rental economics first; see the economics result for what is missing.',
    );
  }
  const { land, acquisitionCosts } = cost.value.components;
  const spend = cost.value.total - land - acquisitionCosts;
  return monthlyPhasing({
    constructionStart: { year: asOf.getUTCFullYear(), month: asOf.getUTCMonth() + 1 },
    constructionDurationMonths: set.constructionMonths,
    completionDelayMonths: set.completionDelayMonths,
    annualRentalIncome: figures.annualIncome,
    annualOperatingExpenses: figures.annualOperatingExpenses,
    constructionSpend:
      set.constructionMonths > 0 && spend > 0 ? { total: spend, profile: 'straight_line' } : null,
    horizonMonths: Math.max(
      1,
      set.constructionMonths + set.completionDelayMonths + set.holdYears * 12,
    ),
  });
}

/** Yearly, unlevered, pre-tax cash flows: land and acquisition up front, then the phased months. */
function yearlyCashFlows(
  cost: DevelopmentCost,
  phasing: MonthlyPhasing,
  set: InputSet,
): DatedCashFlow[] {
  const byYear = new Map<number, number>();
  const upfront = cost.components.land + cost.components.acquisitionCosts;
  const builtAlready = set.constructionMonths === 0 ? cost.total - upfront : 0;
  byYear.set(0, -(upfront + builtAlready));
  for (const month of phasing.months) {
    const year = Math.floor(month.index / 12);
    byYear.set(year, (byYear.get(year) ?? 0) + month.netCashFlow);
  }
  return [...byYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([period, amount]) => ({ period, amount }));
}

function exitAssumption(set: InputSet): ExitAssumption | null {
  if (set.exitValueNaira === null) return null;
  return {
    exitValue: set.exitValueNaira,
    sellingCosts: set.exitValueNaira * set.sellingCostsFraction,
  };
}

function runInvestmentReturns(
  set: InputSet,
  cost: Result<DevelopmentCost>,
  phasing: Result<MonthlyPhasing>,
): { npv: CalculatorResultDto; irr: CalculatorResultDto } {
  if (!cost.ok || !phasing.ok) {
    const reason =
      'NPV and IRR need complete dated cash flows, which need the development cost and phasing first.';
    return { npv: fail(reason), irr: fail(reason) };
  }
  const flows = yearlyCashFlows(cost.value, phasing.value, set);
  const exit = exitAssumption(set);
  // Brief §6.4: NPV/IRR expansion requires an explicit discount rate, exit value and selling costs.
  const irrResult = exit
    ? irr(flows, exit)
    : fail('IRR requires an explicit exit value and selling costs assumption.', [
        'exitValueNaira',
        'sellingCostsFraction',
      ]);
  return {
    npv: toDto(npv(set.discountRate, flows, exit)),
    irr: toDto(irrResult),
  };
}

function derivedFigures(
  set: InputSet,
  cost: Result<DevelopmentCost>,
  figures: OperatingFigures | null,
): CalculatorSetResultDto['derived'] {
  const total = cost.ok && cost.value.total > 0 ? cost.value.total : null;
  const area = set.grossFloorAreaM2;
  return {
    totalDevelopmentCostNaira: total,
    costPerM2Naira: total !== null && area !== null && area > 0 ? total / area : null,
    netYieldPercent: figures?.netYieldPercent ?? null,
    constructionDurationDays: (set.constructionMonths + set.completionDelayMonths) * 30,
  };
}

/** Runs every calculator for one input set. Each figure fails independently and says why. */
export function runInputSet(
  set: InputSet,
  label: CalculatorSetResultDto['set'],
  objective: Objective,
  asOf: Date,
): CalculatorSetResultDto {
  const kind = economicsKindFor(objective);
  const cost = developmentCost(toDevelopmentCostInput(set));
  const denominator: CostDenominator | null = cost.ok
    ? { kind: 'development_cost', amount: cost.value.total }
    : null;
  const longLet = kind === 'long_let' ? runLongLet(toLongLetInput(set, denominator)) : null;
  const shortStay = kind === 'short_stay' ? runShortStay(toShortStayInput(set, denominator)) : null;
  const figures = operatingFigures(kind, longLet, shortStay);
  const phasing = runPhasing(set, cost, figures, asOf);
  const returns = runInvestmentReturns(set, cost, phasing);
  const notes = [
    'Yields divide by total development cost (development-cost denominator).',
    BUILD_RATE_INCLUSIONS.notes,
    'Phasing spreads every cost except land and acquisition evenly over the construction months; rent starts after construction plus the completion delay.',
    'NPV and IRR use yearly, unlevered, pre-tax cash flows with the exit (less selling costs) in the final year.',
  ];
  if (kind === 'long_let' && set.units.length === 0) {
    notes.push('No unit groups were supplied, so annual rent could not be scheduled.');
  }
  return {
    set: label,
    inputs: set,
    economicsKind: kind,
    developmentCost: toDto(cost),
    longLet: longLet ? toDto(longLet) : null,
    shortStay: shortStay ? toDto(shortStay) : null,
    phasing: toDto(phasing),
    npv: returns.npv,
    irr: returns.irr,
    derived: derivedFigures(set, cost, figures),
    notes,
  };
}

function runSensitivity(
  request: CalculatorRunRequest,
  base: InputSet,
  baseResult: CalculatorSetResultDto,
): CalculatorResultDto {
  if (baseResult.economicsKind !== 'long_let') {
    return fail(
      'Sensitivity grids are computed for annual-lease scenarios; short-stay cohorts are kept separate.',
    );
  }
  const denominator: CostDenominator | null =
    baseResult.derived.totalDevelopmentCostNaira !== null
      ? { kind: 'development_cost', amount: baseResult.derived.totalDevelopmentCostNaira }
      : null;
  const holdingCostPerMonth =
    base.constructionMonths > 0 ? base.financingDuringBuildNaira / base.constructionMonths : 0;
  const grid = sensitivityGrid(
    {
      longLet: toLongLetInput(base, denominator) as LongLetInput,
      loan: null,
      delay: { holdingCostPerMonth },
    },
    request.sensitivity,
  );
  return toDto(grid);
}

function runScenarioSets(
  assumptions: ScenarioAssumptions,
  objective: Objective,
  asOf: Date,
): CalculatorRunResponse['scenarioSets'] {
  const kind = economicsKindFor(objective);
  const economicsOf = (set: InputSet): CalculatorResultDto => {
    const result = runInputSet(set, 'base', objective, asOf);
    const chosen = kind === 'long_let' ? result.longLet : result.shortStay;
    return chosen ?? fail('No economics result was produced.');
  };
  const missing = (name: string): CalculatorResultDto =>
    fail(`No ${name} input set was supplied.`, [name]);
  return {
    low: assumptions.low
      ? economicsOf(mergeInputSet(assumptions.base, assumptions.low))
      : missing('low'),
    base: economicsOf(assumptions.base),
    high: assumptions.high
      ? economicsOf(mergeInputSet(assumptions.base, assumptions.high))
      : missing('high'),
  };
}

/** POST /api/v1/calculators/run: pure, nothing persisted. */
export function runCalculatorSuite(
  request: CalculatorRunRequest,
  asOf: Date,
): CalculatorRunResponse {
  const { assumptions, objective } = request;
  const base = runInputSet(assumptions.base, 'base', objective, asOf);
  const low = assumptions.low
    ? runInputSet(mergeInputSet(assumptions.base, assumptions.low), 'low', objective, asOf)
    : null;
  const high = assumptions.high
    ? runInputSet(mergeInputSet(assumptions.base, assumptions.high), 'high', objective, asOf)
    : null;
  return {
    objective,
    sets: { base, low, high },
    sensitivity: runSensitivity(request, assumptions.base, base),
    scenarioSets: runScenarioSets(assumptions, objective, asOf),
    generatedAt: asOf.toISOString(),
    disclaimer: CALCULATOR_DISCLAIMER,
  };
}
