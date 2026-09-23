import {
  ApiError,
  explorerFiltersSchema,
  type ExplorerFilters,
  type Objective,
  type Priorities,
  type RankedMarketDto,
  type RecommendationResponse,
  type ScenarioAssumptions,
} from '@simplexd/contracts';
import {
  rankMarkets,
  type FloodStatus,
  type MarketFlags,
  type MarketInput,
  type MetricContribution,
  type MetricDetail,
  type MetricInput,
  type MetricKey,
  type RankingOptions,
  type RankingResult,
  type ScoredMarket,
  type TitleStatus,
} from '@simplexd/domain/ranking';
import { runInputSet } from './calculators';
import { flagApplies } from './evidence';
import { deriveEvidence, type EvidenceDerivation } from './market-metrics';
import { METRIC_LABELS, MISSING_LABELS, RANKING_METRIC_UNITS } from './metric-map';
import type { PolicyContext } from './policy';
import type { MarketBundle } from './types';

/**
 * Adapter between the read model and the deterministic ranking engine.
 *
 * Evidence mode feeds the engine only rank-eligible, published, local
 * observations. Assumption mode is the visibly separate scenario mode: the
 * user's assumptions are run through the finance calculators and enter the
 * engine as `user_assumption` / `model_estimate` inputs with their own
 * confidence multiplier. Explorer filters are hard constraints applied here,
 * before scoring, so an excluded market never influences a rank.
 */

export const RECOMMENDATION_DISCLAIMER =
  'Scenarios are not valuations or investment advice. Rankings apply a versioned policy whose ' +
  'weights and anchors are proposed product defaults, not researched investment truths. Unknown ' +
  'values never become zero prices or perfect scores; a market without locally applicable cost and ' +
  'rental evidence is shown as needing more local data rather than ranked.';

export const RANKING_DISABLED_REASON =
  'Default financial ranking is switched off by the data policy (the market dataset is a research ' +
  'seed, not a complete financial dataset). Statuses and missing-evidence lists are shown; fits, ' +
  'where any exist, are screening scores only and no market is ranked. Assumption mode remains ' +
  'available as a visibly separate scenario comparison.';

export type RankingMode = 'evidence' | 'assumption';

export interface RankingRequest {
  objective: Objective;
  mode: RankingMode;
  filters: Partial<ExplorerFilters>;
  priorities: Priorities;
  assumptions: ScenarioAssumptions | null;
  rank: boolean;
  budgetCeiling: { amountNaira: number } | null;
}

export interface AdapterInput {
  bundles: readonly MarketBundle[];
  policy: PolicyContext;
  request: RankingRequest;
  asOf: Date;
}

export interface AdapterOutput {
  response: RecommendationResponse;
  result: RankingResult;
  /** The exact engine inputs, stored with every snapshot. */
  marketInputs: MarketInput[];
  options: RankingOptions;
  filters: ExplorerFilters;
}

interface AssumptionFigures {
  inputs: Partial<Record<MetricKey, MetricInput>>;
  totalCostNaira: number | null;
  netYieldPercent: number | null;
}

interface Exclusion {
  reason: string;
  message: string;
}

const AVAILABLE_OR_ON_REQUEST: ReadonlySet<string> = new Set([
  'available',
  'limited',
  'on_request',
]);

const AMENITY_FILTERS = [
  'power',
  'water',
  'internet',
  'transport',
  'schools',
  'hospitals',
  'soilInvestigation',
] as const;

function dateOnly(asOf: Date): string {
  return asOf.toISOString().slice(0, 10);
}

/**
 * Assumption-mode inputs from the base input set: affordability is the total
 * development cost per m² of gross floor area, net rental economics the net
 * yield from the long-let or short-stay model, construction duration the
 * construction months plus completion delay. Zero-cost scenarios yield no
 * affordability input rather than a perfect score.
 */
export function deriveAssumptionFigures(
  assumptions: ScenarioAssumptions,
  objective: Objective,
  asOf: Date,
): AssumptionFigures {
  const base = runInputSet(assumptions.base, 'base', objective, asOf);
  const { derived } = base;
  const common = {
    sourceQuality: 'user_assumption' as const,
    observedAt: dateOnly(asOf),
    geographicLevel: 'city' as const,
    sampleSize: null,
  };
  const inputs: Partial<Record<MetricKey, MetricInput>> = {};
  if (derived.costPerM2Naira !== null && derived.costPerM2Naira > 0) {
    inputs.affordability = {
      ...common,
      value: derived.costPerM2Naira,
      unit: RANKING_METRIC_UNITS.affordability,
      kind: 'model_estimate',
      sourceVersion: 'assumption:base:development_cost',
    };
  }
  if (derived.netYieldPercent !== null && Number.isFinite(derived.netYieldPercent)) {
    inputs.net_rental_economics = {
      ...common,
      value: derived.netYieldPercent,
      unit: RANKING_METRIC_UNITS.net_rental_economics,
      kind: 'model_estimate',
      sourceVersion: `assumption:base:${base.economicsKind}`,
    };
  }
  if (derived.constructionDurationDays !== null && derived.constructionDurationDays > 0) {
    inputs.construction_duration = {
      ...common,
      value: derived.constructionDurationDays,
      unit: RANKING_METRIC_UNITS.construction_duration,
      kind: 'user_assumption',
      sourceVersion: 'assumption:base:schedule',
    };
  }
  return {
    inputs,
    totalCostNaira: derived.totalDevelopmentCostNaira,
    netYieldPercent: derived.netYieldPercent,
  };
}

/** Hard flags from `market_flags`; unknown flood or title status stays unknown, never low risk. */
export function flagsFor(bundle: MarketBundle, asOf: Date): MarketFlags {
  let floodStatus: FloodStatus = 'unknown';
  let titleStatus: TitleStatus = 'unknown';
  const flags: MarketFlags = { floodStatus, titleStatus };
  for (const flag of bundle.flags) {
    if (!flagApplies(flag, asOf)) continue;
    switch (flag.flagType) {
      case 'geographic_exclusion':
        flags.geographicExclusion = true;
        break;
      case 'title_stop':
        flags.titleStop = true;
        titleStatus = 'issues';
        break;
      case 'site_restriction':
        flags.siteRestriction = true;
        break;
      case 'flood_alert':
        floodStatus = 'official_alert';
        break;
      default:
        break;
    }
  }
  return { ...flags, floodStatus, titleStatus };
}

function serviceTeamExclusion(bundle: MarketBundle, filters: ExplorerFilters): Exclusion | null {
  const availability = bundle.market.serviceAvailability;
  if (filters.serviceTeamAvailability === 'available_only' && availability !== 'available') {
    return {
      reason: 'service_team_unavailable',
      message: `Service team availability is "${availability}", not confirmed available.`,
    };
  }
  if (
    filters.serviceTeamAvailability === 'available_or_on_request' &&
    !AVAILABLE_OR_ON_REQUEST.has(availability)
  ) {
    return {
      reason: 'service_team_unavailable',
      message: `Service team availability is "${availability}"; not available or on request.`,
    };
  }
  return null;
}

function floodExclusion(flags: MarketFlags, filters: ExplorerFilters): Exclusion | null {
  const status = flags.floodStatus;
  const unknown = status === 'unknown';
  if (filters.floodExposure === 'low_only' && status !== 'low') {
    if (unknown && filters.includeUnknown) return null;
    return {
      reason: 'flood_exposure',
      message: unknown
        ? 'Flood exposure is unknown; unknown is not low risk.'
        : `Flood status "${status}" is not low.`,
    };
  }
  if (
    filters.floodExposure === 'exclude_high' &&
    (status === 'high' || status === 'official_alert')
  ) {
    return { reason: 'flood_exposure', message: `Flood status "${status}" is excluded.` };
  }
  return null;
}

function amenityExclusion(filters: ExplorerFilters): Exclusion | null {
  if (filters.includeUnknown) return null;
  for (const amenity of AMENITY_FILTERS) {
    if (filters[amenity] === 'required') {
      return {
        reason: `${amenity}_evidence_unknown`,
        message: `${amenity} is required but no locality evidence exists, and unknown values were not included.`,
      };
    }
  }
  return null;
}

function yieldExclusion(
  filters: ExplorerFilters,
  derivation: EvidenceDerivation,
  assumption: AssumptionFigures | null,
): Exclusion | null {
  const minimum = filters.minProjectedNetYieldPercent;
  if (minimum === null) return null;
  const value =
    derivation.inputs.net_rental_economics?.value ?? assumption?.netYieldPercent ?? null;
  if (value === null) {
    return filters.includeUnknown
      ? null
      : { reason: 'net_yield_unknown', message: 'Projected net yield is unknown for this market.' };
  }
  if (value < minimum) {
    return {
      reason: 'below_minimum_net_yield',
      message: `Projected net yield ${value.toFixed(2)}% is below the ${minimum}% minimum.`,
    };
  }
  return null;
}

/** Explorer filters are hard constraints, evaluated before scoring. */
export function explorerExclusion(
  bundle: MarketBundle,
  filters: ExplorerFilters,
  flags: MarketFlags,
  derivation: EvidenceDerivation,
  assumption: AssumptionFigures | null,
  ceiling: number | null,
): Exclusion | null {
  const { market } = bundle;
  if (
    filters.preferredZones.length > 0 &&
    !filters.preferredZones.includes(market.geopoliticalZone)
  ) {
    return {
      reason: 'outside_preferred_zones',
      message: 'Outside the preferred geopolitical zones.',
    };
  }
  if (filters.preferredStateIds.length > 0 && !filters.preferredStateIds.includes(market.stateId)) {
    return { reason: 'outside_preferred_states', message: 'Outside the preferred states.' };
  }
  if (
    assumption &&
    ceiling !== null &&
    assumption.totalCostNaira !== null &&
    assumption.totalCostNaira > ceiling
  ) {
    return {
      reason: 'assumed_cost_exceeds_budget',
      message: `The assumed total development cost (NGN ${formatNaira(assumption.totalCostNaira)}) exceeds the budget ceiling (NGN ${formatNaira(ceiling)}).`,
    };
  }
  return (
    serviceTeamExclusion(bundle, filters) ??
    floodExclusion(flags, filters) ??
    amenityExclusion(filters) ??
    yieldExclusion(filters, derivation, assumption)
  );
}

function formatNaira(value: number): string {
  return new Intl.NumberFormat('en-NG', { maximumFractionDigits: 0 }).format(value);
}

function formatValue(value: number | null, unit: string | null): string {
  if (value === null) return 'unknown';
  const rounded = Number.isInteger(value) ? value : Number(value.toFixed(2));
  switch (unit) {
    case 'NGN/m2':
      return `NGN ${formatNaira(rounded)} per m²`;
    case 'percent':
      return `${rounded}%`;
    case 'days':
      return `${rounded} days`;
    default:
      return `${rounded}${unit ? ` ${unit}` : ''}`;
  }
}

const REASON_TEXT: Record<string, string> = {
  invalid_value: 'the value could not be normalised',
  unit_mismatch: 'the unit does not match the policy unit',
  cohort_mismatch: 'the observation cohort does not match the requested cohort',
  kind_not_eligible: 'this kind of input is not eligible in this mode',
  undated: 'the observation carries no date',
  stale: 'older than the freshness policy',
  statewide_context: 'statewide context, never a city value',
  unverified_lead: 'an unverified lead',
  zero_confidence: 'the confidence multiplier is zero',
};

type ContributionDto = RankedMarketDto['metrics'][number];

function toContribution(
  detail: MetricDetail,
  mode: RankingMode,
  contribution: number | null,
): ContributionDto {
  const eligible = mode === 'assumption' ? detail.assumptionEligible : detail.evidenceEligible;
  const reasons =
    mode === 'assumption' ? detail.assumptionIneligibilityReasons : detail.ineligibilityReasons;
  const reason = !detail.present
    ? 'no rank-eligible local evidence'
    : eligible
      ? null
      : reasons.map((r) => REASON_TEXT[r] ?? r).join('; ');
  return {
    metric: detail.metric,
    weight: detail.weight,
    score: detail.score,
    confidence: detail.confidence,
    contribution,
    badge: detail.badge,
    evidenceDate: detail.evidenceDate,
    unit: detail.unit,
    value: detail.value,
    geographicScope: detail.geographicScope,
    eligible,
    reason,
  };
}

function topContributorsOf(scored: ScoredMarket, mode: RankingMode): MetricContribution[] {
  return mode === 'assumption'
    ? (scored.assumption?.topContributors ?? [])
    : scored.topContributors;
}

function contributionsOf(scored: ScoredMarket, mode: RankingMode): Map<MetricKey, number> {
  const list =
    mode === 'assumption' ? (scored.assumption?.contributions ?? []) : scored.contributions;
  return new Map(list.map((c) => [c.metric, c.contribution]));
}

function whyMatches(
  scored: ScoredMarket,
  mode: RankingMode,
  details: Map<MetricKey, MetricDetail>,
): string[] {
  const fit = mode === 'assumption' ? scored.assumptionFit : scored.fit;
  if (fit === null) return [];
  return topContributorsOf(scored, mode).map((top) => {
    const detail = details.get(top.metric);
    const basis =
      detail?.badge === 'user_assumption' || detail?.badge === 'model_estimate'
        ? 'your assumption'
        : `${detail?.geographicScope ?? 'observation'}${detail?.evidenceDate ? `, ${detail.evidenceDate}` : ''}`;
    return `${METRIC_LABELS[top.metric]}: ${formatValue(detail?.value ?? null, detail?.unit ?? null)} (${basis}) contributes ${top.contribution.toFixed(1)} of ${fit.toFixed(1)} fit points.`;
  });
}

function missingEvidence(scored: ScoredMarket, bundle: MarketBundle): string[] {
  const items = scored.missing.map((m) => MISSING_LABELS[m]);
  for (const task of bundle.tasks) if (task.status !== 'done') items.push(task.title);
  return [...new Set(items)];
}

function toRankedMarket(
  scored: ScoredMarket,
  bundle: MarketBundle,
  mode: RankingMode,
  rankingEnabled: boolean,
): RankedMarketDto {
  const details = new Map(scored.metrics.map((d) => [d.metric, d]));
  const contributions = contributionsOf(scored, mode);
  const withContribution = (detail: MetricDetail): ContributionDto =>
    toContribution(detail, mode, contributions.get(detail.metric) ?? null);
  return {
    marketId: bundle.market.id,
    slug: bundle.market.slug,
    name: bundle.market.name,
    stateName: bundle.state.name,
    rank: rankingEnabled ? scored.rank : null,
    status: scored.status,
    fit: scored.fit,
    assumptionFit: scored.assumptionFit,
    coverage:
      mode === 'assumption' ? (scored.assumption?.coverage ?? scored.coverage) : scored.coverage,
    confidence: mode === 'assumption' ? (scored.assumption?.confidence ?? null) : scored.confidence,
    missing: scored.missing,
    exclusionReason: scored.exclusionReason,
    budgetAssessable: scored.budgetAssessable,
    riskAssessment: { flood: scored.riskAssessment.flood, title: scored.riskAssessment.title },
    topContributors: topContributorsOf(scored, mode)
      .map((top) => details.get(top.metric))
      .filter((d): d is MetricDetail => d !== undefined)
      .map(withContribution),
    metrics: scored.metrics.map(withContribution),
    biddingWindowDays: scored.biddingWindowDays,
    whyMatches: whyMatches(scored, mode, details),
    missingEvidence: missingEvidence(scored, bundle),
    lastReviewedAt: bundle.market.lastReviewedAt?.toISOString() ?? null,
  };
}

function toPreExcluded(
  bundle: MarketBundle,
  flags: MarketFlags,
  exclusion: Exclusion,
): RankedMarketDto {
  return {
    marketId: bundle.market.id,
    slug: bundle.market.slug,
    name: bundle.market.name,
    stateName: bundle.state.name,
    rank: null,
    status: 'excluded',
    fit: null,
    assumptionFit: null,
    coverage: null,
    confidence: null,
    missing: [],
    exclusionReason: exclusion.reason,
    budgetAssessable: null,
    riskAssessment: {
      flood: flags.floodStatus === 'unknown' ? 'unable_to_assess' : flags.floodStatus,
      title: flags.titleStatus === 'unknown' ? 'unable_to_assess' : flags.titleStatus,
    },
    topContributors: [],
    metrics: [],
    biddingWindowDays: null,
    whyMatches: [],
    missingEvidence: [exclusion.message],
    lastReviewedAt: bundle.market.lastReviewedAt?.toISOString() ?? null,
  };
}

function ceilingFor(request: RankingRequest, filters: ExplorerFilters): number | null {
  return request.budgetCeiling?.amountNaira ?? filters.totalBudgetNaira ?? null;
}

/** Engine inputs and options prepared from bundles and a request; shared by ranking and comparison. */
export interface PreparedMarkets {
  marketInputs: MarketInput[];
  included: MarketBundle[];
  preExcluded: RankedMarketDto[];
  options: RankingOptions;
  filters: ExplorerFilters;
  mode: RankingMode;
  rankingEnabled: boolean;
}

export function prepareMarkets(input: AdapterInput): PreparedMarkets {
  const { bundles, policy, request, asOf } = input;
  const filters = explorerFiltersSchema.parse(request.filters);
  const mode = request.mode;
  if (mode === 'assumption' && !request.assumptions) {
    throw new ApiError('validation_failed', 'assumption mode requires scenario assumptions');
  }
  const assumption =
    mode === 'assumption' && request.assumptions
      ? deriveAssumptionFigures(request.assumptions, request.objective, asOf)
      : null;
  const ceiling = ceilingFor(request, filters);
  const rankingEnabled = mode === 'assumption' || policy.settings.defaultFinancialRankingEnabled;

  const marketInputs: MarketInput[] = [];
  const included: MarketBundle[] = [];
  const preExcluded: RankedMarketDto[] = [];
  for (const bundle of bundles) {
    const derivation = deriveEvidence(bundle.local, {
      asOf,
      policies: policy.policies,
      landAreaM2: filters.landAreaM2,
      floorAreaM2: filters.floorAreaM2,
      includeStale: filters.evidenceFreshness === 'include_stale',
    });
    const flags = flagsFor(bundle, asOf);
    const exclusion = explorerExclusion(bundle, filters, flags, derivation, assumption, ceiling);
    if (exclusion) {
      preExcluded.push(toPreExcluded(bundle, flags, exclusion));
      continue;
    }
    included.push(bundle);
    marketInputs.push({
      id: bundle.market.id,
      name: bundle.market.name,
      // Local evidence takes the metric slot; the user's assumption fills what evidence leaves empty.
      metrics: { ...(assumption?.inputs ?? {}), ...derivation.inputs },
      flags,
      hasLocalCostEvidence: derivation.hasLocalCostEvidence,
      hasLocalRentEvidence: derivation.hasLocalRentEvidence,
      totalCostEvidence: derivation.totalCostEvidence,
      parentMarketId: bundle.market.parentMarketId,
      biddingWindowDays: null,
    });
  }

  const options: RankingOptions = {
    asOf: asOf.toISOString(),
    objective: request.objective,
    mode,
    rank: request.rank && rankingEnabled,
    freshnessDays: policy.freshnessDays,
    priorityOverrides: request.priorities,
    budgetCeiling: ceiling !== null ? { amount: ceiling, unit: 'NGN' } : null,
    ...(filters.assetType ? { cohort: filters.assetType } : {}),
  };
  return { marketInputs, included, preExcluded, options, filters, mode, rankingEnabled };
}

/** Builds the engine inputs, runs the engine and maps the result onto the wire contract. */
export function runRankingAdapter(input: AdapterInput): AdapterOutput {
  const { policy, request, asOf } = input;
  const prepared = prepareMarkets(input);
  const { marketInputs, included, preExcluded, options, filters, mode, rankingEnabled } = prepared;
  const result = rankMarkets(marketInputs, policy.policy, options);
  const byId = new Map(included.map((b) => [b.market.id, b]));
  const map = (scored: ScoredMarket): RankedMarketDto => {
    const bundle = byId.get(scored.id);
    if (!bundle) throw new Error(`internal: engine returned unknown market ${scored.id}`);
    return toRankedMarket(scored, bundle, mode, rankingEnabled);
  };

  const response: RecommendationResponse = {
    policyVersion: result.policyVersion,
    mode,
    objective: request.objective,
    rankingEnabled,
    rankingDisabledReason: rankingEnabled ? null : RANKING_DISABLED_REASON,
    effectiveWeights: result.effectiveWeights,
    organic: result.organic.map(map),
    sponsored: result.sponsored.map(map),
    excluded: [...result.excluded.map(map), ...preExcluded].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    policyErrors: result.policyErrors,
    snapshotId: null,
    generatedAt: asOf.toISOString(),
    disclaimer: RECOMMENDATION_DISCLAIMER,
  };
  return { response, result, marketInputs, options, filters };
}
