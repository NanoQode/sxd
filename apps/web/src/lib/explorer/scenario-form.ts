import { z } from 'zod';
import {
  scenarioAssumptionsSchema,
  type CalculatorRunRequest,
  type ExplorerFilters,
  type InputSet,
  type Objective,
  type Priorities,
  type ScenarioAssumptions,
  type ScenarioCreate,
} from '@simplexd/contracts';

/**
 * Scenario builder form model. Inputs are edited as text (whole naira, m²,
 * months, percentages) and converted to the contract's numbers and fractions.
 * A blank optional input stays `null` (missing), never a silent zero: the
 * calculators must be able to say what is absent.
 */

export const DEFAULT_ASSUMPTIONS: ScenarioAssumptions = scenarioAssumptionsSchema.parse({
  base: {},
});

/** Text → number; blank → null; anything unparsable → NaN (caught by validation). */
export function parseNumberInput(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return Number.NaN;
  const cleaned = value.replace(/[,\s₦_]/g, '');
  if (cleaned === '') return null;
  return Number(cleaned);
}

interface NumberTextOptions {
  min?: number;
  max: number;
  integer?: boolean;
  /** Multiplier applied after parsing (percent inputs → fractions). */
  scale?: number;
  label: string;
}

const preprocessNumber = (options: NumberTextOptions) => (v: unknown) => {
  const n = parseNumberInput(v);
  return n === null ? null : n * (options.scale ?? 1);
};

const boundedNumber = (options: NumberTextOptions) =>
  z
    .number({ error: `${options.label} must be a number` })
    .finite(`${options.label} must be a number`)
    .min(options.min ?? 0, `${options.label} must be at least ${options.min ?? 0}`)
    .max(options.max, `${options.label} is too large`)
    .refine((n) => !options.integer || Number.isInteger(n), {
      message: `${options.label} must be a whole number`,
    });

/** Optional numeric text input: blank stays null (missing), never a silent zero. */
const numberText = (options: NumberTextOptions) =>
  z.preprocess(preprocessNumber(options), boundedNumber(options).nullable());

/** Required numeric text input. */
const requiredNumberText = (options: NumberTextOptions) =>
  z.preprocess(preprocessNumber(options), boundedNumber(options));

const naira = (label: string) => numberText({ max: 1e13, label });
const percent = (label: string) => numberText({ max: 1, scale: 0.01, label: `${label} (%)` });
const months = (label: string, max: number) => numberText({ max, integer: true, label });

const unitGroupFormSchema = z.object({
  label: z.string().max(60),
  count: requiredNumberText({ min: 1, max: 1000, integer: true, label: 'Number of units' }),
  annualRentPerUnitNaira: requiredNumberText({ max: 1e13, label: 'Annual rent per unit' }),
});

export const scenarioFormSchema = z.object({
  landCostNaira: naira('Land cost'),
  acquisitionCostsNaira: naira('Acquisition costs'),
  grossFloorAreaM2: numberText({ max: 1e6, label: 'Gross floor area' }),
  buildRateNairaPerM2: naira('Build rate per m²'),
  boqTotalNaira: naira('Priced BOQ total'),
  professionalFeesNaira: naira('Professional fees'),
  approvalsNaira: naira('Approvals'),
  utilitiesAndExternalWorksNaira: naira('Utilities and external works'),
  contingencyPercent: percent('Contingency'),
  financingDuringBuildNaira: naira('Financing during build'),
  units: z.array(unitGroupFormSchema).max(20),
  vacancyPercent: percent('Vacancy rate'),
  collectionLossPercent: percent('Collection loss'),
  otherAnnualIncomeNaira: naira('Other annual income'),
  managementFeePercent: percent('Management fee'),
  managementFeeFixedNaira: naira('Fixed management fee'),
  maintenanceNaira: naira('Maintenance'),
  insuranceNaira: naira('Insurance'),
  serviceCostsNaira: naira('Service costs'),
  unrecoverableChargesNaira: naira('Unrecoverable charges'),
  taxKind: z.enum(['none', 'fraction_of_noi', 'fixed']),
  taxPercent: percent('Tax on NOI'),
  taxFixedNaira: naira('Fixed annual tax'),
  capexReserveNaira: naira('Capex reserve'),
  annualDebtServiceNaira: naira('Annual debt service'),
  equityNaira: naira('Equity invested'),
  constructionMonths: months('Construction months', 120),
  completionDelayMonths: months('Completion delay months', 60),
  shortStayEnabled: z.boolean(),
  shortStay: z.object({
    availableNightsPerYear: months('Available nights per year', 366),
    occupiedPercent: percent('Occupied nights'),
    nightlyRateNaira: naira('Nightly rate'),
    platformChargePercent: percent('Platform charge'),
    cleaningCostPerStayNaira: naira('Cleaning cost per stay'),
    averageLengthOfStayNights: numberText({ max: 366, label: 'Average length of stay' }),
    operatingCostsNaira: naira('Short-stay operating costs'),
  }),
  discountPercent: percent('Discount rate'),
  exitValueNaira: naira('Exit value'),
  sellingCostsPercent: percent('Selling costs'),
  holdYears: months('Hold years', 40),
  low: z.object({
    enabled: z.boolean(),
    vacancyPercent: percent('Low vacancy rate'),
    landCostNaira: naira('Low land cost'),
    buildRateNairaPerM2: naira('Low build rate'),
    completionDelayMonths: months('Low completion delay', 60),
    annualDebtServiceNaira: naira('Low debt service'),
    unitRents: z.array(naira('Low annual rent per unit')),
  }),
  high: z.object({
    enabled: z.boolean(),
    vacancyPercent: percent('High vacancy rate'),
    landCostNaira: naira('High land cost'),
    buildRateNairaPerM2: naira('High build rate'),
    completionDelayMonths: months('High completion delay', 60),
    annualDebtServiceNaira: naira('High debt service'),
    unitRents: z.array(naira('High annual rent per unit')),
  }),
  notes: z.string().max(2000),
});

export type ScenarioFormInput = z.input<typeof scenarioFormSchema>;
export type ScenarioFormOutput = z.output<typeof scenarioFormSchema>;

type SetForm = ScenarioFormOutput['low'];

const orZero = (n: number | null): number => n ?? 0;

/** Converts validated form output into contract assumptions. */
export function assumptionsFromForm(form: ScenarioFormOutput): ScenarioAssumptions {
  const units = form.units.map((group) => ({
    label: group.label.trim() === '' ? 'Units' : group.label.trim(),
    count: group.count,
    annualRentPerUnitNaira: group.annualRentPerUnitNaira,
  }));
  const base: InputSet = {
    landCostNaira: form.landCostNaira,
    acquisitionCostsNaira: orZero(form.acquisitionCostsNaira),
    grossFloorAreaM2: form.grossFloorAreaM2,
    buildRateNairaPerM2: form.buildRateNairaPerM2,
    boqTotalNaira: form.boqTotalNaira,
    professionalFeesNaira: orZero(form.professionalFeesNaira),
    approvalsNaira: orZero(form.approvalsNaira),
    utilitiesAndExternalWorksNaira: orZero(form.utilitiesAndExternalWorksNaira),
    contingencyFraction: orZero(form.contingencyPercent),
    financingDuringBuildNaira: orZero(form.financingDuringBuildNaira),
    units,
    vacancyRate: orZero(form.vacancyPercent),
    collectionLossRate: orZero(form.collectionLossPercent),
    otherAnnualIncomeNaira: orZero(form.otherAnnualIncomeNaira),
    opex: {
      managementFeeFraction: form.managementFeePercent,
      managementFeeFixedNaira: form.managementFeeFixedNaira,
      maintenanceNaira: orZero(form.maintenanceNaira),
      insuranceNaira: orZero(form.insuranceNaira),
      serviceCostsNaira: orZero(form.serviceCostsNaira),
      unrecoverableChargesNaira: orZero(form.unrecoverableChargesNaira),
    },
    tax:
      form.taxKind === 'fraction_of_noi'
        ? { kind: 'fraction_of_noi', value: orZero(form.taxPercent) }
        : form.taxKind === 'fixed'
          ? { kind: 'fixed', value: orZero(form.taxFixedNaira) }
          : { kind: 'none' },
    capexReserveNaira: orZero(form.capexReserveNaira),
    annualDebtServiceNaira: orZero(form.annualDebtServiceNaira),
    equityNaira: form.equityNaira,
    constructionMonths: form.constructionMonths ?? 12,
    completionDelayMonths: form.completionDelayMonths ?? 0,
    shortStay:
      form.shortStayEnabled &&
      form.shortStay.availableNightsPerYear !== null &&
      form.shortStay.occupiedPercent !== null &&
      form.shortStay.nightlyRateNaira !== null
        ? {
            availableNightsPerYear: form.shortStay.availableNightsPerYear,
            occupiedNightFraction: form.shortStay.occupiedPercent,
            nightlyRateNaira: form.shortStay.nightlyRateNaira,
            platformChargeFraction: orZero(form.shortStay.platformChargePercent),
            cleaningCostPerStayNaira: orZero(form.shortStay.cleaningCostPerStayNaira),
            averageLengthOfStayNights: form.shortStay.averageLengthOfStayNights ?? 2,
            operatingCostsNaira: orZero(form.shortStay.operatingCostsNaira),
          }
        : null,
    discountRate: form.discountPercent,
    exitValueNaira: form.exitValueNaira,
    sellingCostsFraction: orZero(form.sellingCostsPercent),
    holdYears: form.holdYears ?? 10,
  };

  const setOverrides = (set: SetForm): Partial<InputSet> | null => {
    if (!set.enabled) return null;
    const partial: Partial<InputSet> = {};
    if (set.vacancyPercent !== null) partial.vacancyRate = set.vacancyPercent;
    if (set.landCostNaira !== null) partial.landCostNaira = set.landCostNaira;
    if (set.buildRateNairaPerM2 !== null) partial.buildRateNairaPerM2 = set.buildRateNairaPerM2;
    if (set.completionDelayMonths !== null)
      partial.completionDelayMonths = set.completionDelayMonths;
    if (set.annualDebtServiceNaira !== null)
      partial.annualDebtServiceNaira = set.annualDebtServiceNaira;
    if (set.unitRents.some((rent) => rent !== null) && units.length > 0) {
      partial.units = units.map((group, index) => {
        const rent = set.unitRents[index] ?? null;
        return rent === null ? group : { ...group, annualRentPerUnitNaira: rent };
      });
    }
    return Object.keys(partial).length > 0 ? partial : null;
  };

  return {
    base,
    low: setOverrides(form.low),
    high: setOverrides(form.high),
    notes: form.notes.trim() === '' ? null : form.notes.trim(),
  };
}

const text = (n: number | null | undefined): string =>
  n === null || n === undefined ? '' : String(n);
const percentText = (fraction: number | null | undefined): string =>
  fraction === null || fraction === undefined ? '' : String(Math.round(fraction * 10000) / 100);

function setForm(
  set: Partial<InputSet> | null | undefined,
  baseUnits: InputSet['units'],
): ScenarioFormInput['low'] {
  const overrideRents = set?.units ?? null;
  return {
    enabled: Boolean(set && Object.keys(set).length > 0),
    vacancyPercent: percentText(set?.vacancyRate),
    landCostNaira: text(set?.landCostNaira),
    buildRateNairaPerM2: text(set?.buildRateNairaPerM2),
    completionDelayMonths: text(set?.completionDelayMonths),
    annualDebtServiceNaira: text(set?.annualDebtServiceNaira),
    unitRents: baseUnits.map((group, index) => {
      const override = overrideRents?.[index];
      return override && override.annualRentPerUnitNaira !== group.annualRentPerUnitNaira
        ? text(override.annualRentPerUnitNaira)
        : '';
    }),
  };
}

/** Form values (text) from contract assumptions, for initial values and scenario loading. */
export function formFromAssumptions(assumptions: ScenarioAssumptions): ScenarioFormInput {
  const base = assumptions.base;
  return {
    landCostNaira: text(base.landCostNaira),
    acquisitionCostsNaira: text(base.acquisitionCostsNaira),
    grossFloorAreaM2: text(base.grossFloorAreaM2),
    buildRateNairaPerM2: text(base.buildRateNairaPerM2),
    boqTotalNaira: text(base.boqTotalNaira),
    professionalFeesNaira: text(base.professionalFeesNaira),
    approvalsNaira: text(base.approvalsNaira),
    utilitiesAndExternalWorksNaira: text(base.utilitiesAndExternalWorksNaira),
    contingencyPercent: percentText(base.contingencyFraction),
    financingDuringBuildNaira: text(base.financingDuringBuildNaira),
    units: base.units.map((group) => ({
      label: group.label,
      count: text(group.count),
      annualRentPerUnitNaira: text(group.annualRentPerUnitNaira),
    })),
    vacancyPercent: percentText(base.vacancyRate),
    collectionLossPercent: percentText(base.collectionLossRate),
    otherAnnualIncomeNaira: text(base.otherAnnualIncomeNaira),
    managementFeePercent: percentText(base.opex.managementFeeFraction),
    managementFeeFixedNaira: text(base.opex.managementFeeFixedNaira),
    maintenanceNaira: text(base.opex.maintenanceNaira),
    insuranceNaira: text(base.opex.insuranceNaira),
    serviceCostsNaira: text(base.opex.serviceCostsNaira),
    unrecoverableChargesNaira: text(base.opex.unrecoverableChargesNaira),
    taxKind: base.tax.kind,
    taxPercent: base.tax.kind === 'fraction_of_noi' ? percentText(base.tax.value) : '',
    taxFixedNaira: base.tax.kind === 'fixed' ? text(base.tax.value) : '',
    capexReserveNaira: text(base.capexReserveNaira),
    annualDebtServiceNaira: text(base.annualDebtServiceNaira),
    equityNaira: text(base.equityNaira),
    constructionMonths: text(base.constructionMonths),
    completionDelayMonths: text(base.completionDelayMonths),
    shortStayEnabled: base.shortStay !== null,
    shortStay: {
      availableNightsPerYear: text(base.shortStay?.availableNightsPerYear),
      occupiedPercent: percentText(base.shortStay?.occupiedNightFraction),
      nightlyRateNaira: text(base.shortStay?.nightlyRateNaira),
      platformChargePercent: percentText(base.shortStay?.platformChargeFraction),
      cleaningCostPerStayNaira: text(base.shortStay?.cleaningCostPerStayNaira),
      averageLengthOfStayNights: text(base.shortStay?.averageLengthOfStayNights),
      operatingCostsNaira: text(base.shortStay?.operatingCostsNaira),
    },
    discountPercent: percentText(base.discountRate),
    exitValueNaira: text(base.exitValueNaira),
    sellingCostsPercent: percentText(base.sellingCostsFraction),
    holdYears: text(base.holdYears),
    low: setForm(assumptions.low, base.units),
    high: setForm(assumptions.high, base.units),
    notes: assumptions.notes ?? '',
  };
}

/** True when the base set has enough to run the long-let and cost calculators. */
export function assumptionsAreUsable(assumptions: ScenarioAssumptions): boolean {
  const base = assumptions.base;
  const hasCost =
    base.landCostNaira !== null &&
    (base.boqTotalNaira !== null ||
      (base.grossFloorAreaM2 !== null && base.buildRateNairaPerM2 !== null));
  return hasCost && (base.units.length > 0 || base.shortStay !== null);
}

/** Inputs the calculators still need, named for the "missing" state. */
export function missingAssumptionInputs(assumptions: ScenarioAssumptions): string[] {
  const base = assumptions.base;
  const missing: string[] = [];
  if (base.landCostNaira === null) missing.push('land cost');
  if (
    base.boqTotalNaira === null &&
    (base.grossFloorAreaM2 === null || base.buildRateNairaPerM2 === null)
  ) {
    missing.push('gross floor area and build rate (or a priced BOQ total)');
  }
  if (base.units.length === 0 && base.shortStay === null) {
    missing.push('at least one unit group with an annual rent (or short-stay inputs)');
  }
  return missing;
}

/** Sensitivity variations requested with every calculator run. */
export function defaultSensitivity(): NonNullable<CalculatorRunRequest['sensitivity']> {
  return {
    vacancy: [0, 0.05, 0.1, 0.15, 0.2, 0.3],
    rents: [0.8, 0.9, 1, 1.1, 1.2],
    costs: [0.8, 0.9, 1, 1.1, 1.2],
    interest: [],
    completionDelayMonths: [0, 3, 6, 12],
  };
}

export function buildCalculatorRequest(
  assumptions: ScenarioAssumptions,
  objective: Objective,
): CalculatorRunRequest {
  return { assumptions, objective, sensitivity: defaultSensitivity() };
}

export function buildScenarioCreate(input: {
  name: string;
  objective: Objective;
  mode: 'evidence' | 'assumption';
  filters: ExplorerFilters;
  assumptions: ScenarioAssumptions;
  priorities: Priorities;
  marketIds: string[];
}): ScenarioCreate {
  return {
    name:
      input.name.trim() === ''
        ? defaultScenarioName(input.objective)
        : input.name.trim().slice(0, 120),
    objective: input.objective,
    mode: input.mode,
    filters: input.filters,
    assumptions: input.assumptions,
    priorities: input.priorities,
    marketIds: input.marketIds.slice(0, 10),
  };
}

export function defaultScenarioName(objective: Objective, date: Date = new Date()): string {
  const label = objective.replace(/_/g, ' ');
  const day = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} scenario · ${day}`;
}

/** Deterministic key for query caching (stable key order). */
export function stableKey(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}
