/**
 * Market ranking engine: types.
 *
 * Build brief §6.3 (quoted): "Build a deterministic, versioned service, not an LLM choosing
 * cities."
 *
 * Everything in this module is a plain value. The engine performs no I/O, reads no clock and
 * consults no database: freshness is evaluated against the `asOf` date the caller passes in, so the
 * same inputs, policy and options always produce the same result.
 */

// ---------------------------------------------------------------------------------------------
// Metrics and policy
// ---------------------------------------------------------------------------------------------

/** The scored metrics, in canonical order. Every weighted sum iterates in this order. */
export const METRIC_KEYS = [
  'affordability',
  'material_access',
  'net_rental_economics',
  'construction_duration',
  'approval_duration',
  'evidence_backed_demand',
  'infrastructure_site_suitability',
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export type MetricDirection = 'higher_is_better' | 'lower_is_better';

/**
 * Approved normalisation anchors for one metric.
 *
 * Brief (quoted): "Define metric direction, unit, approved lower/upper anchors and clamping in the
 * admin policy." Bounds are fixed per policy version; they never change with the user's viewport
 * ("Do not change score bounds when a user pans the map").
 */
export interface MetricBound {
  metric: MetricKey;
  direction: MetricDirection;
  /** Unit the anchors are expressed in. An input in a different unit is never normalised. */
  unit: string;
  low: number;
  high: number;
  /** Property cohort the anchors were approved for. A bound without a cohort is the fallback. */
  cohort?: string;
}

/** Data badges (brief §6.2): "Never use one generic Verified label for all of these." */
export const INPUT_KINDS = [
  'sourced_observation',
  'verified_operational_record',
  'regional_context',
  'model_estimate',
  'user_assumption',
  'unknown',
  'stale',
  'disputed',
] as const;
export type InputKind = (typeof INPUT_KINDS)[number];

export const SOURCE_QUALITIES = [
  'first_party_verified',
  'licensed_dataset',
  'official_publication',
  'published_report_read',
  'unverified_lead',
  'user_assumption',
] as const;
export type SourceQuality = (typeof SOURCE_QUALITIES)[number];

export const GEOGRAPHIC_LEVELS = [
  'site',
  'neighborhood',
  'city',
  'state_or_fct',
  'country',
] as const;
export type GeographicLevel = (typeof GEOGRAPHIC_LEVELS)[number];

/**
 * Confidence rubric. Brief (quoted): "Confidence has an explicit source-quality, freshness,
 * geographic-match and sample-size rubric. Multipliers are configuration, not hidden AI
 * judgments." Every factor is a number in [0, 1]; the multiplier is their product.
 */
export interface ConfidenceRubric {
  sourceQuality: Record<SourceQuality, number>;
  freshness: { within_policy: number; stale: number };
  geographicMatch: Record<GeographicLevel, number>;
  /**
   * Thresholds are matched after sorting by `min` descending; the first threshold whose `min` the
   * sample size reaches wins. A null/undefined sample size, or one below every threshold, uses the
   * lowest threshold's multiplier.
   */
  sampleSize: { thresholds: Array<{ min: number; multiplier: number }> };
}

/** A versioned, admin-approved ranking policy. Saved recommendations record its version. */
export interface RankingPolicy {
  version: number;
  /** Weights per metric. Persisted as saved; the engine renormalises a working copy, never mutates. */
  weights: Record<MetricKey, number>;
  metricBounds: MetricBound[];
  confidenceRubric: ConfidenceRubric;
  /** Minimum weighted coverage for an investment ranking. Product default 0.7. */
  coverageThreshold: number;
  /**
   * Deduplicated comparables required before a local median may be published. This is a publication
   * policy enforced upstream when observations are published; the engine carries it so the value
   * travels with the policy version, and validates it, but does not apply it to inputs.
   */
  minComparables: number;
}

/** A metric-specific error raised by policy validation. `metric` is null for policy-wide errors. */
export interface PolicyError {
  metric: MetricKey | null;
  message: string;
}

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

/** One observation, record, estimate or assumption feeding a metric for one market. */
export interface MetricInput {
  value: number;
  /** Unit of `value`. Must match the policy bound's unit to be normalised. */
  unit: string;
  kind: InputKind;
  sourceQuality: SourceQuality;
  /** ISO 8601 date (or date-time) the value was observed, or the date an assumption was made. */
  observedAt: string | null;
  /** Source-declared validity; when present it is respected in addition to the freshness window. */
  validUntil?: string | null;
  geographicLevel: GeographicLevel;
  sampleSize?: number | null;
  cohort?: string;
  sourceVersion?: string;
}

export type FloodStatus = 'unknown' | 'low' | 'moderate' | 'high' | 'official_alert';
export type TitleStatus = 'unknown' | 'verified' | 'issues';

export interface MarketFlags {
  /** Approved geographic exclusion: the market is excluded with a reason, never scored. */
  geographicExclusion?: boolean;
  /** Legal/title stop flag: blocks the market. */
  titleStop?: boolean;
  /** Site restriction: blocks the market. */
  siteRestriction?: boolean;
  /** "Unknown flood or title status is not low risk." Unknown is reported as unable to assess. */
  floodStatus: FloodStatus;
  titleStatus: TitleStatus;
}

export interface MarketInput {
  id: string;
  name: string;
  metrics: Partial<Record<MetricKey, MetricInput | null>>;
  flags: MarketFlags;
  /** Locally applicable cost evidence exists (verdict of the upstream evidence review). */
  hasLocalCostEvidence: boolean;
  /** Locally applicable rental evidence exists (verdict of the upstream evidence review). */
  hasLocalRentEvidence: boolean;
  /** Sponsored placement. Returned separately and labelled; never changes a fit or the organic order. */
  sponsored?: boolean;
  /**
   * Days until the relevant tender closes. Brief (quoted): "Tender closing dates are schedule
   * constraints and a separately visible factor; a short bidding window is not automatically
   * desirable." Exposed on the output as information, never scored.
   */
  biddingWindowDays?: number | null;
  /**
   * Total development cost for the user's brief, used only by the budget-ceiling hard constraint.
   * It is judged as cost evidence (affordability freshness window) and compared only when its unit
   * equals the ceiling's unit.
   */
  totalCostEvidence?: MetricInput | null;
  /** Parent market for overlapping geographies (e.g. Ikeja within Lagos metro). */
  parentMarketId?: string | null;
  /** Explicit overlap group shared by markets whose populations, listings or demand overlap. */
  overlapGroup?: string | null;
}

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

export const INVESTMENT_OBJECTIVES = [
  'long_term_rent',
  'development_for_sale',
  'student_housing',
  'commercial',
  'short_stay',
] as const;
export type InvestmentObjective = (typeof INVESTMENT_OBJECTIVES)[number];
export type Objective = InvestmentObjective | 'owner_occupation';
export const OBJECTIVES: readonly Objective[] = [...INVESTMENT_OBJECTIVES, 'owner_occupation'];

/**
 * 'evidence' is the default ranking. 'assumption' is the visibly separate scenario mode in which
 * user assumptions and model estimates also count, with their configured confidence multiplier.
 */
export type RankingMode = 'evidence' | 'assumption';
export const RANKING_MODES: readonly RankingMode[] = ['evidence', 'assumption'];

export interface BudgetCeiling {
  amount: number;
  /** Unit the ceiling is expressed in; cost evidence in any other unit is not comparable. */
  unit: string;
}

export interface RankingOptions {
  /** ISO 8601 date or date-time the ranking is evaluated at. Required: the engine never reads a clock. */
  asOf: string;
  objective: Objective;
  mode: RankingMode;
  /**
   * When true (default) the result is a ranking and the ranking gates apply (local cost and rent
   * evidence, coverage threshold). When false the engine only screens: fits are computed where
   * possible, gates are not applied, and markets are marked 'scored' rather than 'ranked'.
   */
  rank?: boolean;
  /**
   * Freshness window in days per metric. `null` means no age limit for that metric (only the
   * source's own `validUntil` applies, e.g. official risk layers valid until the next edition).
   */
  freshnessDays: Record<MetricKey, number | null>;
  /** User priorities: 0–1 multipliers applied to the policy weights before renormalising. */
  priorityOverrides?: Partial<Record<MetricKey, number>>;
  /** Total budget ceiling. Applied only where the market has valid cost evidence in the same unit. */
  budgetCeiling?: BudgetCeiling | null;
  /** Property cohort used to select cohort-specific bounds and to match cohort-tagged inputs. */
  cohort?: string;
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

export type FreshnessStatus = 'fresh' | 'stale' | 'undated';

export type IneligibilityReason =
  | 'invalid_value'
  | 'unit_mismatch'
  | 'cohort_mismatch'
  | 'kind_not_eligible'
  | 'undated'
  | 'stale'
  | 'statewide_context'
  | 'unverified_lead'
  | 'zero_confidence';

export type GeographicScopeLabel =
  | 'site observation'
  | 'neighbourhood observation'
  | 'city observation'
  | 'statewide context'
  | 'national context';

export interface ConfidenceFactors {
  sourceQuality: number;
  freshness: number;
  geographicMatch: number;
  sampleSize: number;
}

/** Per-metric explanation for one market. */
export interface MetricDetail {
  metric: MetricKey;
  /** Effective (renormalised) weight used for this run. */
  weight: number;
  present: boolean;
  /** The data badge: the input kind, or 'stale' when the freshness policy marks the input stale, or 'unknown' when absent. */
  badge: InputKind;
  value: number | null;
  unit: string | null;
  policyUnit: string;
  direction: MetricDirection;
  evidenceDate: string | null;
  validUntil: string | null;
  freshness: FreshnessStatus | null;
  geographicLevel: GeographicLevel | null;
  geographicScope: GeographicScopeLabel | null;
  sourceQuality: SourceQuality | null;
  sampleSize: number | null;
  sourceVersion: string | null;
  /** Confidence multiplier c in [0, 1]; reported for every present input, eligible or not. */
  confidence: number | null;
  confidenceFactors: ConfidenceFactors | null;
  /** Normalised score s in [0, 1]; only reported for inputs eligible in at least one basis. */
  score: number | null;
  evidenceEligible: boolean;
  assumptionEligible: boolean;
  /** Why the input is not evidence-eligible (empty when it is). */
  ineligibilityReasons: IneligibilityReason[];
  /** Why the input is not assumption-eligible (empty when it is). */
  assumptionIneligibilityReasons: IneligibilityReason[];
  /** Points of the reported evidence fit contributed by this metric; null when there is no fit. */
  contribution: number | null;
}

export interface MetricContribution {
  metric: MetricKey;
  weight: number;
  score: number;
  confidence: number;
  /** 100 * w * s * c / sum(w * c): contributions add up to the fit. */
  contribution: number;
}

/** A fit computed over one eligibility basis. */
export interface FitBreakdown {
  /** 100 * sum(w*s*c) / sum(w*c) over eligible metrics; null when the denominator is zero. */
  fit: number | null;
  /** sum(w for available eligible metrics) / sum(all selected w). */
  coverage: number;
  /** Mean confidence multiplier over eligible metrics; null when none is eligible. */
  confidence: number | null;
  eligibleMetrics: MetricKey[];
  contributions: MetricContribution[];
  /** Top three contributing metrics. */
  topContributors: MetricContribution[];
}

/** Assumption-mode figures. Clearly typed as assumptions: never an evidence-backed ranking. */
export interface AssumptionBreakdown {
  assumptionFit: number | null;
  coverage: number;
  confidence: number | null;
  eligibleMetrics: MetricKey[];
  contributions: MetricContribution[];
  topContributors: MetricContribution[];
}

export type MarketStatus = 'ranked' | 'scored' | 'more_local_data_needed' | 'excluded';
export type ExclusionReason = 'geographic_exclusion' | 'blocked' | 'over_budget';
export type BlockingFlag = 'title_stop' | 'site_restriction';

export type FloodAssessment = 'unable_to_assess' | 'low' | 'moderate' | 'high' | 'official_alert';
export type TitleAssessment = 'unable_to_assess' | 'verified' | 'issues';

/** "Show inability to assess rather than certifying safety." Unknown maps to unable_to_assess. */
export interface RiskAssessment {
  flood: FloodAssessment;
  title: TitleAssessment;
}

/** Evidence flags a ranking can be missing, listed alongside metric keys in `missing`. */
export type MissingEvidence = 'local_cost_evidence' | 'local_rent_evidence';

export interface ScoredMarket {
  id: string;
  name: string;
  status: MarketStatus;
  /** 1-based position in the organic list; null when the market is not ranked on the ordering basis. */
  rank: number | null;
  exclusionReason: ExclusionReason | null;
  blockedBy: BlockingFlag[];
  /** Evidence fit 0–100. Null unless the market passed the ranking gates (or, when screening, unless computable). */
  fit: number | null;
  /** Evidence coverage 0–1, reported even when the market is not ranked. */
  coverage: number;
  /** Mean confidence over evidence-eligible metrics. */
  confidence: number | null;
  eligibleMetrics: MetricKey[];
  contributions: MetricContribution[];
  topContributors: MetricContribution[];
  /** Metric keys and evidence flags the ranking is missing. */
  missing: Array<MetricKey | MissingEvidence>;
  /** Assumption-mode fit 0–100; null in evidence mode. Never an evidence-backed figure. */
  assumptionFit: number | null;
  assumption: AssumptionBreakdown | null;
  metrics: MetricDetail[];
  riskAssessment: RiskAssessment;
  /** Null when no budget ceiling was supplied; false when cost evidence is missing or not comparable. */
  budgetAssessable: boolean | null;
  /** Information only; never scored. */
  biddingWindowDays: number | null;
  sponsored: boolean;
  placement: 'organic' | 'sponsored';
  /** 'Sponsored' on sponsored placements, otherwise null. */
  label: string | null;
}

export interface RankingResult {
  policyVersion: number;
  asOf: string;
  objective: Objective;
  mode: RankingMode;
  rankingRequested: boolean;
  /** Which figure the organic list is ordered by. */
  orderedBy: 'fit' | 'assumptionFit';
  coverageThreshold: number;
  /** Renormalised weights actually used (policy weights × priority overrides, omitted metrics at 0). */
  effectiveWeights: Record<MetricKey, number>;
  /** Metrics omitted for the objective (net_rental_economics for owner occupation). */
  omittedMetrics: MetricKey[];
  /** Metrics disabled by policy errors. */
  disabledMetrics: MetricKey[];
  priorityOverrides: Partial<Record<MetricKey, number>>;
  policyErrors: PolicyError[];
  /** Non-excluded markets ordered by fit desc, confidence desc, id asc. Sponsorship never affects it. */
  organic: ScoredMarket[];
  /** Sponsored placements, labelled, ordered like the organic list. */
  sponsored: ScoredMarket[];
  /** Markets removed by a hard constraint, with the reason, ordered by id. */
  excluded: ScoredMarket[];
}

// ---------------------------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------------------------

export interface ComparisonCell {
  marketId: string;
  present: boolean;
  badge: InputKind;
  value: number | null;
  unit: string | null;
  evidenceDate: string | null;
  validUntil: string | null;
  freshness: FreshnessStatus | null;
  confidence: number | null;
  geographicLevel: GeographicLevel | null;
  /** Human label for the scope; a statewide observation is always 'statewide context'. */
  geographicScope: GeographicScopeLabel | null;
  score: number | null;
  evidenceEligible: boolean;
  assumptionEligible: boolean;
  ineligibilityReasons: IneligibilityReason[];
}

export interface ComparisonRow {
  metric: MetricKey;
  /** Unit the policy anchors are expressed in. */
  unit: string;
  direction: MetricDirection;
  weight: number;
  /** One cell per compared market, in the order the markets were given. */
  cells: ComparisonCell[];
}

export interface ComparisonMarketSummary {
  id: string;
  name: string;
  status: MarketStatus;
  exclusionReason: ExclusionReason | null;
  fit: number | null;
  assumptionFit: number | null;
  coverage: number;
  confidence: number | null;
  missing: Array<MetricKey | MissingEvidence>;
  riskAssessment: RiskAssessment;
  biddingWindowDays: number | null;
  sponsored: boolean;
}

export interface OverlapWarning {
  /** Pairs of market ids that overlap, each pair sorted, pairs sorted. */
  pairs: Array<[string, string]>;
  message: string;
}

export interface ComparisonResult {
  policyVersion: number;
  asOf: string;
  objective: Objective;
  mode: RankingMode;
  marketIds: string[];
  markets: ComparisonMarketSummary[];
  rows: ComparisonRow[];
  /** Scope labels per market id and metric, e.g. labels['lagos'].affordability === 'statewide context'. */
  labels: Record<string, Partial<Record<MetricKey, GeographicScopeLabel>>>;
  overlapWarning: OverlapWarning | null;
  policyErrors: PolicyError[];
}

// ---------------------------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------------------------

export interface SnapshotSource {
  policy: RankingPolicy;
  inputs: MarketInput[];
  /** Source versions (e.g. source id → version). Collected from the inputs' `sourceVersion` fields when omitted. */
  sourceVersions?: Record<string, string>;
}

/** What a saved recommendation stores: policy version, inputs (by stable hash) and source versions. */
export interface RecommendationSnapshot {
  policyVersion: number;
  generatedFrom: {
    inputsHash: string;
    policyHash: string;
    sourceVersions: Record<string, string>;
  };
  results: RankingResult;
}
