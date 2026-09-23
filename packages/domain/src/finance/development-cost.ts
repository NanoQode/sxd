import type { AreaUnit, DeclaredArea } from './area';
import { convertArea } from './area';
import type { Result } from './result';
import { fail, InputCheck, isPresent, ok } from './result';

/**
 * Scope of the build figure. Brief §6.4: "Explain inclusions such as roof,
 * finishes and external works." The object is passed through untouched so a
 * report can state what the cost covers.
 */
export interface BuildInclusions {
  /** Roof structure and covering are in the build figure. */
  roof: boolean;
  /** Internal finishes (floors, walls, ceilings, fittings) are in the build figure. */
  finishes: boolean;
  /** External works (fencing, paving, drainage, landscaping) are in the build figure. */
  externalWorks: boolean;
  /** Free-text scope notes, e.g. "excludes borehole and generator house". */
  notes?: string;
}

/** `build_cost = gross_floor_area_m2 * approved_build_rate_ngn_per_m2`. */
export interface AreaRateBuildInput {
  /** Actual gross floor area with its declared unit; a plot count is rejected. */
  grossFloorArea: DeclaredArea;
  /** Approved build rate in naira per square metre. */
  approvedBuildRateNgnPerM2: number;
}

/** A priced bill of quantities. */
export interface BoqBuildInput {
  /** Priced BOQ total in naira. */
  totalNgn: number;
  /** Document reference or version, for the audit trail. */
  reference?: string;
}

export interface BuildCostInput {
  areaRate?: AreaRateBuildInput | null;
  /** When supplied, the BOQ is the basis and the area-rate estimate is never added to it. */
  boq?: BoqBuildInput | null;
  inclusions: BuildInclusions;
}

export type BuildCostBasis = 'area_rate' | 'boq';

export interface AreaRateEstimate {
  grossFloorAreaM2: number;
  /** The area exactly as declared by the caller. */
  declaredArea: { value: number; unit: AreaUnit };
  approvedBuildRateNgnPerM2: number;
  /** `grossFloorAreaM2 * approvedBuildRateNgnPerM2`. */
  estimate: number;
}

export interface BuildCost {
  /** Which figure `amount` is: the area-rate estimate or the priced BOQ. */
  basis: BuildCostBasis;
  amount: number;
  inclusions: BuildInclusions;
  /** Area-rate detail when `basis` is `'area_rate'`. */
  areaRate: AreaRateEstimate | null;
  /** BOQ detail when `basis` is `'boq'`. */
  boq: { totalNgn: number; reference: string | null } | null;
  /**
   * When the basis is the BOQ and valid area-rate inputs were also supplied,
   * the area-rate estimate is reported here for cross-checking only. It is
   * never added to `amount`.
   */
  areaRateCrossCheck: number | null;
}

export type ContingencyInput =
  { kind: 'amount'; amount: number } | { kind: 'fraction_of_build_and_fees'; fraction: number };

export type ContingencyBasis =
  | { kind: 'amount'; amount: number }
  | { kind: 'fraction_of_build_and_fees'; fraction: number; base: number; amount: number };

/**
 * Brief §6.4: `total_development_cost = land + acquisition_costs + build_cost
 * + professional_fees + approvals + utilities_and_external_works + contingency
 * + financing_during_build`. Every component is required; a component that
 * genuinely does not apply must be passed as 0 rather than omitted, so nothing
 * is ever defaulted.
 */
export interface DevelopmentCostInput {
  land: number;
  acquisitionCosts: number;
  build: BuildCostInput;
  professionalFees: number;
  approvals: number;
  utilitiesAndExternalWorks: number;
  contingency: ContingencyInput;
  financingDuringBuild: number;
}

export interface DevelopmentCostComponents {
  land: number;
  acquisitionCosts: number;
  buildCost: number;
  professionalFees: number;
  approvals: number;
  utilitiesAndExternalWorks: number;
  contingency: number;
  financingDuringBuild: number;
}

export interface DevelopmentCost {
  /** Sum of the eight components, whole-naira scenario arithmetic. */
  total: number;
  components: DevelopmentCostComponents;
  build: BuildCost;
  contingency: ContingencyBasis;
}

function checkInclusions(check: InputCheck, value: unknown): BuildInclusions | null {
  if (!isPresent(value) || typeof value !== 'object') {
    check.absent('build.inclusions');
    return null;
  }
  const candidate = value as Partial<Record<keyof BuildInclusions, unknown>>;
  let valid = true;
  for (const flag of ['roof', 'finishes', 'externalWorks'] as const) {
    if (typeof candidate[flag] !== 'boolean') {
      if (isPresent(candidate[flag]))
        check.problem(`build.inclusions.${flag} must be true or false`);
      else check.absent(`build.inclusions.${flag}`);
      valid = false;
    }
  }
  if (isPresent(candidate.notes) && typeof candidate.notes !== 'string') {
    check.problem('build.inclusions.notes must be text');
    valid = false;
  }
  if (!valid) return null;
  const inclusions: BuildInclusions = {
    roof: candidate.roof as boolean,
    finishes: candidate.finishes as boolean,
    externalWorks: candidate.externalWorks as boolean,
  };
  if (typeof candidate.notes === 'string') inclusions.notes = candidate.notes;
  return inclusions;
}

/** The area-rate estimate on its own: `gross_floor_area_m2 * approved_build_rate_ngn_per_m2`. */
export function areaRateEstimate(
  input: AreaRateBuildInput | null | undefined,
): Result<AreaRateEstimate> {
  if (!isPresent(input)) {
    return fail('An area-rate estimate needs a gross floor area and an approved build rate.', [
      'build.areaRate.grossFloorArea',
      'build.areaRate.approvedBuildRateNgnPerM2',
    ]);
  }
  const check = new InputCheck();
  const area = convertArea(input.grossFloorArea);
  check.absorb(area, 'build.areaRate.grossFloorArea');
  const rate = check.positive(
    'build.areaRate.approvedBuildRateNgnPerM2',
    input.approvedBuildRateNgnPerM2,
  );
  if (check.failed || !area.ok) return check.failure();
  return ok({
    grossFloorAreaM2: area.value.m2,
    declaredArea: area.value.declared,
    approvedBuildRateNgnPerM2: rate,
    estimate: area.value.m2 * rate,
  });
}

/**
 * Build cost on a single, explicit basis. Brief §6.4: `build_cost =
 * gross_floor_area_m2 * approved_build_rate_ngn_per_m2, or a priced BOQ when
 * available. Never add a BOQ to the area-rate estimate.` When both are
 * supplied the BOQ wins and the estimate is reported only as a cross-check.
 */
export function buildCost(input: BuildCostInput | null | undefined): Result<BuildCost> {
  if (!isPresent(input)) return fail('Build cost inputs are required.', ['build']);
  const check = new InputCheck();
  const inclusions = checkInclusions(check, input.inclusions);
  const hasBoq = isPresent(input.boq);
  const hasAreaRate = isPresent(input.areaRate);
  if (!hasBoq && !hasAreaRate) {
    check.absent('build.areaRate');
    check.absent('build.boq');
    check.problem(
      'build cost needs either an area-rate estimate (gross floor area × approved build rate) or a priced BOQ total',
    );
    return check.failure();
  }

  if (isPresent(input.boq)) {
    const total = check.positive('build.boq.totalNgn', input.boq.totalNgn);
    if (isPresent(input.boq.reference) && typeof input.boq.reference !== 'string') {
      check.problem('build.boq.reference must be text');
    }
    if (check.failed || inclusions === null) return check.failure();
    const crossCheck = hasAreaRate ? areaRateEstimate(input.areaRate) : null;
    return ok({
      basis: 'boq',
      amount: total,
      inclusions,
      areaRate: null,
      boq: { totalNgn: total, reference: input.boq.reference ?? null },
      areaRateCrossCheck: crossCheck !== null && crossCheck.ok ? crossCheck.value.estimate : null,
    });
  }

  const estimate = areaRateEstimate(input.areaRate);
  check.absorb(estimate);
  if (check.failed || inclusions === null || !estimate.ok) return check.failure();
  return ok({
    basis: 'area_rate',
    amount: estimate.value.estimate,
    inclusions,
    areaRate: estimate.value,
    boq: null,
    areaRateCrossCheck: null,
  });
}

function checkContingency(
  check: InputCheck,
  value: unknown,
): { kind: 'amount'; amount: number } | { kind: 'fraction'; fraction: number } | null {
  if (!isPresent(value) || typeof value !== 'object') {
    check.absent('contingency');
    return null;
  }
  const candidate = value as { kind?: unknown; amount?: unknown; fraction?: unknown };
  if (candidate.kind === 'amount') {
    const amount = check.amount('contingency.amount', candidate.amount);
    return Number.isFinite(amount) ? { kind: 'amount', amount } : null;
  }
  if (candidate.kind === 'fraction_of_build_and_fees') {
    const fraction = check.fraction('contingency.fraction', candidate.fraction);
    return Number.isFinite(fraction) ? { kind: 'fraction', fraction } : null;
  }
  if (isPresent(candidate.kind)) {
    check.problem("contingency.kind must be 'amount' or 'fraction_of_build_and_fees'");
  } else {
    check.absent('contingency.kind');
  }
  return null;
}

/**
 * Total development cost per brief §6.4. Contingency is either an explicit
 * amount or an explicit fraction of `build_cost + professional_fees`; the
 * result records which, together with the base the fraction was applied to.
 */
export function developmentCost(
  input: DevelopmentCostInput | null | undefined,
): Result<DevelopmentCost> {
  if (!isPresent(input)) return fail('Development cost inputs are required.', ['developmentCost']);
  const check = new InputCheck();
  const land = check.amount('land', input.land);
  const acquisitionCosts = check.amount('acquisitionCosts', input.acquisitionCosts);
  const build = buildCost(input.build);
  check.absorb(build);
  const professionalFees = check.amount('professionalFees', input.professionalFees);
  const approvals = check.amount('approvals', input.approvals);
  const utilitiesAndExternalWorks = check.amount(
    'utilitiesAndExternalWorks',
    input.utilitiesAndExternalWorks,
  );
  const contingencyInput = checkContingency(check, input.contingency);
  const financingDuringBuild = check.amount('financingDuringBuild', input.financingDuringBuild);
  if (check.failed || !build.ok || contingencyInput === null) return check.failure();

  const buildAmount = build.value.amount;
  const contingency: ContingencyBasis =
    contingencyInput.kind === 'amount'
      ? { kind: 'amount', amount: contingencyInput.amount }
      : {
          kind: 'fraction_of_build_and_fees',
          fraction: contingencyInput.fraction,
          base: buildAmount + professionalFees,
          amount: (buildAmount + professionalFees) * contingencyInput.fraction,
        };

  const components: DevelopmentCostComponents = {
    land,
    acquisitionCosts,
    buildCost: buildAmount,
    professionalFees,
    approvals,
    utilitiesAndExternalWorks,
    contingency: contingency.amount,
    financingDuringBuild,
  };
  const total =
    components.land +
    components.acquisitionCosts +
    components.buildCost +
    components.professionalFees +
    components.approvals +
    components.utilitiesAndExternalWorks +
    components.contingency +
    components.financingDuringBuild;

  return ok({ total, components, build: build.value, contingency });
}
