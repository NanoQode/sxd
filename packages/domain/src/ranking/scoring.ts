/**
 * Scoring one market against a prepared policy.
 *
 * Brief (quoted): "For weights w, metric scores s and confidence multipliers c in [0,1]:
 * `fit = 100 * sum(w*s*c)/sum(w*c)` over eligible metrics. Separately report
 * `coverage = sum(w for available eligible metrics)/sum(all selected w)`. [...] No score if the
 * denominator is zero."
 */

import { parseIsoDate } from './dates';
import {
  assessEligibility,
  confidenceFactors,
  confidenceMultiplier,
  CONTEXT_LEVELS,
  evaluateFreshness,
  EVIDENCE_KINDS,
  GEOGRAPHIC_SCOPE_LABELS,
} from './eligibility';
import { normaliseScore, unitsMatch } from './normalise';
import { analysePolicy, resolveEffectiveWeights, selectBound } from './policy';
import { METRIC_KEYS, OBJECTIVES, RANKING_MODES } from './types';
import type {
  AssumptionBreakdown,
  BlockingFlag,
  ConfidenceRubric,
  ExclusionReason,
  FitBreakdown,
  MarketFlags,
  MarketInput,
  MarketStatus,
  MetricBound,
  MetricContribution,
  MetricDetail,
  MetricKey,
  MissingEvidence,
  PolicyError,
  RankingMode,
  RankingOptions,
  RankingPolicy,
  RiskAssessment,
  ScoredMarket,
} from './types';

/** Tolerance for the coverage gate so that weights summing to 0.7000000000000001 still pass 0.7. */
export const COVERAGE_EPSILON = 1e-9;
export const TOP_CONTRIBUTOR_COUNT = 3;

/** Everything derived once per run from the policy and options, shared by every market. */
export interface RankingContext {
  policy: RankingPolicy;
  options: RankingOptions;
  rank: boolean;
  mode: RankingMode;
  asOfMs: number;
  policyErrors: PolicyError[];
  disabledMetrics: MetricKey[];
  omittedMetrics: MetricKey[];
  effectiveWeights: Record<MetricKey, number>;
  selectedMetrics: MetricKey[];
  appliedOverrides: Partial<Record<MetricKey, number>>;
  bounds: Partial<Record<MetricKey, MetricBound>>;
  rubric: ConfidenceRubric;
  coverageThreshold: number;
  /** Owner occupation omits yield, so it does not require rental evidence; every objective requires cost evidence. */
  requiresLocalRentEvidence: boolean;
}

function fail(message: string): never {
  throw new TypeError(message);
}

/**
 * Validates the options, analyses the policy and resolves bounds and weights for one run.
 * Throws a TypeError for a malformed request; policy defects never throw, they are reported as
 * `policyErrors` and disable the affected metric.
 */
export function prepareRanking(policy: RankingPolicy, options: RankingOptions): RankingContext {
  const asOf = parseIsoDate(options.asOf);
  if (!asOf) fail(`options.asOf must be an ISO 8601 date, got ${JSON.stringify(options.asOf)}`);
  if (!OBJECTIVES.includes(options.objective)) {
    fail(
      `options.objective must be one of ${OBJECTIVES.join(', ')}, got ${JSON.stringify(options.objective)}`,
    );
  }
  if (!RANKING_MODES.includes(options.mode)) {
    fail(`options.mode must be 'evidence' or 'assumption', got ${JSON.stringify(options.mode)}`);
  }
  for (const metric of METRIC_KEYS) {
    const window = options.freshnessDays?.[metric];
    const ok =
      window === null || (typeof window === 'number' && Number.isFinite(window) && window >= 0);
    if (!ok) fail(`options.freshnessDays.${metric} must be a non-negative number of days or null`);
  }
  const ceiling = options.budgetCeiling ?? null;
  if (ceiling) {
    const ok =
      typeof ceiling.amount === 'number' &&
      Number.isFinite(ceiling.amount) &&
      ceiling.amount >= 0 &&
      typeof ceiling.unit === 'string' &&
      ceiling.unit.trim() !== '';
    if (!ok) fail('options.budgetCeiling must have a finite amount >= 0 and a non-empty unit');
  }

  const analysis = analysePolicy(policy);
  const policyErrors = [...analysis.errors];
  const disabled = new Set(analysis.disabledMetrics);
  const bounds: Partial<Record<MetricKey, MetricBound>> = {};
  for (const metric of METRIC_KEYS) {
    if (disabled.has(metric)) continue;
    const candidates = policy.metricBounds.filter((bound) => bound.metric === metric);
    if (candidates.length === 0) continue;
    const chosen = selectBound(candidates, options.cohort);
    if (!chosen) {
      policyErrors.push({
        metric,
        message: `no bound approved for cohort ${JSON.stringify(options.cohort)} and no cohort-free fallback; metric disabled`,
      });
      disabled.add(metric);
      continue;
    }
    bounds[metric] = chosen;
  }
  const disabledMetrics = METRIC_KEYS.filter((metric) => disabled.has(metric));
  const weights = resolveEffectiveWeights(policy, {
    objective: options.objective,
    priorityOverrides: options.priorityOverrides,
    disabledMetrics,
  });

  return {
    policy,
    options,
    rank: options.rank !== false,
    mode: options.mode,
    asOfMs: asOf.ms,
    policyErrors,
    disabledMetrics,
    omittedMetrics: weights.omittedMetrics,
    effectiveWeights: weights.effectiveWeights,
    selectedMetrics: weights.selectedMetrics,
    appliedOverrides: weights.appliedOverrides,
    bounds,
    rubric: analysis.rubric,
    coverageThreshold: analysis.coverageThreshold,
    requiresLocalRentEvidence: options.objective !== 'owner_occupation',
  };
}

interface EligibleValue {
  score: number;
  confidence: number;
}

interface EvaluatedMetric {
  metric: MetricKey;
  weight: number;
  detail: Omit<MetricDetail, 'contribution'>;
  evidence: EligibleValue | null;
  assumption: EligibleValue | null;
}

function evaluateMetric(
  market: MarketInput,
  metric: MetricKey,
  ctx: RankingContext,
): EvaluatedMetric {
  const weight = ctx.effectiveWeights[metric];
  const bound = ctx.bounds[metric];
  if (!bound) throw new Error(`internal: selected metric ${metric} has no bound`);
  const input = market.metrics?.[metric] ?? null;
  const base = { metric, weight, policyUnit: bound.unit, direction: bound.direction };

  if (!input) {
    // Absent is absent: no value, no score, nothing in either sum.
    return {
      metric,
      weight,
      evidence: null,
      assumption: null,
      detail: {
        ...base,
        present: false,
        badge: 'unknown',
        value: null,
        unit: null,
        evidenceDate: null,
        validUntil: null,
        freshness: null,
        geographicLevel: null,
        geographicScope: null,
        sourceQuality: null,
        sampleSize: null,
        sourceVersion: null,
        confidence: null,
        confidenceFactors: null,
        score: null,
        evidenceEligible: false,
        assumptionEligible: false,
        ineligibilityReasons: [],
        assumptionIneligibilityReasons: [],
      },
    };
  }

  const freshness = evaluateFreshness(input, ctx.options.freshnessDays[metric], ctx.asOfMs);
  const factors = confidenceFactors(input, freshness, ctx.rubric);
  const confidence = confidenceMultiplier(factors);
  const rawScore = normaliseScore(input.value, bound);
  const eligibility = assessEligibility({
    input,
    bound,
    freshness,
    confidence,
    score: rawScore,
    cohort: ctx.options.cohort,
  });
  // A normalised score is only reported for inputs that are eligible somewhere; a score for a
  // statewide median or a stale quote would invite exactly the misuse the policy forbids.
  const score = eligibility.evidenceEligible || eligibility.assumptionEligible ? rawScore : null;

  return {
    metric,
    weight,
    evidence: eligibility.evidenceEligible && score !== null ? { score, confidence } : null,
    assumption: eligibility.assumptionEligible && score !== null ? { score, confidence } : null,
    detail: {
      ...base,
      present: true,
      // "stale => excluded from default ranking but reported as stale"; a disputed badge stays disputed.
      badge: freshness === 'stale' && input.kind !== 'disputed' ? 'stale' : input.kind,
      value: typeof input.value === 'number' && Number.isFinite(input.value) ? input.value : null,
      unit: input.unit,
      evidenceDate: input.observedAt,
      validUntil: input.validUntil ?? null,
      freshness,
      geographicLevel: input.geographicLevel,
      geographicScope: GEOGRAPHIC_SCOPE_LABELS[input.geographicLevel] ?? null,
      sourceQuality: input.sourceQuality,
      sampleSize: input.sampleSize ?? null,
      sourceVersion: input.sourceVersion ?? null,
      confidence,
      confidenceFactors: factors,
      score,
      evidenceEligible: eligibility.evidenceEligible,
      assumptionEligible: eligibility.assumptionEligible,
      ineligibilityReasons: eligibility.evidenceReasons,
      assumptionIneligibilityReasons: eligibility.assumptionReasons,
    },
  };
}

function compareMetricKeys(a: MetricKey, b: MetricKey): number {
  return METRIC_KEYS.indexOf(a) - METRIC_KEYS.indexOf(b);
}

/**
 * fit = 100 * sum(w*s*c) / sum(w*c) and coverage = sum(w eligible) / sum(w selected) over one
 * eligibility basis. Missing or ineligible metrics are absent from both sums of the fit and from the
 * coverage numerator: they never become zero prices or perfect scores.
 */
export function computeBasis(
  evaluated: readonly EvaluatedMetric[],
  basis: 'evidence' | 'assumption',
): FitBreakdown {
  let numerator = 0;
  let denominator = 0;
  let coveredWeight = 0;
  let selectedWeight = 0;
  let confidenceSum = 0;
  const rows: Array<Omit<MetricContribution, 'contribution'>> = [];

  for (const item of evaluated) {
    selectedWeight += item.weight;
    const value = basis === 'evidence' ? item.evidence : item.assumption;
    if (!value) continue;
    numerator += item.weight * value.score * value.confidence;
    denominator += item.weight * value.confidence;
    coveredWeight += item.weight;
    confidenceSum += value.confidence;
    rows.push({
      metric: item.metric,
      weight: item.weight,
      score: value.score,
      confidence: value.confidence,
    });
  }

  const fit = denominator > 0 ? (100 * numerator) / denominator : null;
  const contributions: MetricContribution[] =
    fit === null
      ? []
      : rows.map((row) => ({
          ...row,
          contribution: (100 * row.weight * row.score * row.confidence) / denominator,
        }));
  const topContributors = [...contributions]
    .sort((a, b) => b.contribution - a.contribution || compareMetricKeys(a.metric, b.metric))
    .slice(0, TOP_CONTRIBUTOR_COUNT);

  return {
    fit,
    coverage: selectedWeight > 0 ? coveredWeight / selectedWeight : 0,
    confidence: rows.length > 0 ? confidenceSum / rows.length : null,
    eligibleMetrics: rows.map((row) => row.metric),
    contributions,
    topContributors,
  };
}

/** "Unknown flood or title status is not low risk. Show inability to assess rather than certifying safety." */
export function assessRisk(flags: MarketFlags): RiskAssessment {
  const flood = flags.floodStatus;
  const title = flags.titleStatus;
  return {
    flood:
      flood === 'low' || flood === 'moderate' || flood === 'high' || flood === 'official_alert'
        ? flood
        : 'unable_to_assess',
    title: title === 'verified' || title === 'issues' ? title : 'unable_to_assess',
  };
}

interface BudgetAssessment {
  /** null when no ceiling was supplied. */
  assessable: boolean | null;
  overBudget: boolean;
}

/**
 * Budget ceiling: "total budget ceiling where cost evidence is valid". Valid cost evidence is a
 * fresh, local, evidence-kind input in the ceiling's unit. Missing or invalid evidence never
 * excludes; it makes the budget unassessable.
 */
function assessBudget(market: MarketInput, ctx: RankingContext): BudgetAssessment {
  const ceiling = ctx.options.budgetCeiling ?? null;
  if (!ceiling) return { assessable: null, overBudget: false };
  const evidence = market.totalCostEvidence ?? null;
  if (!evidence) return { assessable: false, overBudget: false };
  const freshness = evaluateFreshness(
    evidence,
    ctx.options.freshnessDays.affordability,
    ctx.asOfMs,
  );
  const valid =
    EVIDENCE_KINDS.includes(evidence.kind) &&
    freshness === 'fresh' &&
    !CONTEXT_LEVELS.includes(evidence.geographicLevel) &&
    evidence.sourceQuality !== 'unverified_lead' &&
    typeof evidence.value === 'number' &&
    Number.isFinite(evidence.value) &&
    unitsMatch(evidence.unit, ceiling.unit);
  if (!valid) return { assessable: false, overBudget: false };
  return { assessable: true, overBudget: evidence.value > ceiling.amount };
}

/**
 * Scores one market. The market's `rank`, `placement` and `label` are filled in by the caller that
 * orders the list; `scoreMarket` itself never looks at other markets.
 */
export function scoreMarket(market: MarketInput, ctx: RankingContext): ScoredMarket {
  const evaluated = ctx.selectedMetrics.map((metric) => evaluateMetric(market, metric, ctx));
  const evidence = computeBasis(evaluated, 'evidence');
  const assumption = ctx.mode === 'assumption' ? computeBasis(evaluated, 'assumption') : null;

  // Hard constraints: never scored, they exclude.
  const blockedBy: BlockingFlag[] = [];
  if (market.flags.titleStop) blockedBy.push('title_stop');
  if (market.flags.siteRestriction) blockedBy.push('site_restriction');
  const budget = assessBudget(market, ctx);
  const exclusionReason: ExclusionReason | null = market.flags.geographicExclusion
    ? 'geographic_exclusion'
    : blockedBy.length > 0
      ? 'blocked'
      : budget.overBudget
        ? 'over_budget'
        : null;

  // Ranking gates: "require locally applicable cost AND rental inputs, plus at least 70% weighted coverage".
  const missing: Array<MetricKey | MissingEvidence> = evaluated
    .filter((item) => item.evidence === null)
    .map((item) => item.metric);
  if (!market.hasLocalCostEvidence) missing.push('local_cost_evidence');
  if (ctx.requiresLocalRentEvidence && !market.hasLocalRentEvidence)
    missing.push('local_rent_evidence');
  const evidenceGate =
    market.hasLocalCostEvidence === true &&
    (!ctx.requiresLocalRentEvidence || market.hasLocalRentEvidence === true);
  const coverageGate = evidence.coverage + COVERAGE_EPSILON >= ctx.coverageThreshold;

  let status: MarketStatus;
  let reported: FitBreakdown | null = null;
  if (exclusionReason !== null) {
    status = 'excluded';
  } else if (evidence.fit === null) {
    status = 'more_local_data_needed';
  } else if (!ctx.rank) {
    status = 'scored';
    reported = evidence;
  } else if (evidenceGate && coverageGate) {
    status = 'ranked';
    reported = evidence;
  } else {
    status = 'more_local_data_needed';
  }

  const contributions = reported?.contributions ?? [];
  const contributionByMetric = new Map(
    contributions.map((item) => [item.metric, item.contribution]),
  );
  const metrics: MetricDetail[] = evaluated.map((item) => ({
    ...item.detail,
    contribution: contributionByMetric.get(item.metric) ?? null,
  }));

  const assumptionBreakdown: AssumptionBreakdown | null =
    assumption && exclusionReason === null
      ? {
          assumptionFit: assumption.fit,
          coverage: assumption.coverage,
          confidence: assumption.confidence,
          eligibleMetrics: assumption.eligibleMetrics,
          contributions: assumption.contributions,
          topContributors: assumption.topContributors,
        }
      : null;

  const biddingWindowDays = market.biddingWindowDays;
  return {
    id: market.id,
    name: market.name,
    status,
    rank: null,
    exclusionReason,
    blockedBy,
    fit: reported?.fit ?? null,
    coverage: evidence.coverage,
    confidence: evidence.confidence,
    eligibleMetrics: evidence.eligibleMetrics,
    contributions,
    topContributors: reported?.topContributors ?? [],
    missing,
    assumptionFit: assumptionBreakdown?.assumptionFit ?? null,
    assumption: assumptionBreakdown,
    metrics,
    riskAssessment: assessRisk(market.flags),
    budgetAssessable: budget.assessable,
    // Information only: a bidding window is a schedule constraint, never a scored metric.
    biddingWindowDays:
      typeof biddingWindowDays === 'number' && Number.isFinite(biddingWindowDays)
        ? biddingWindowDays
        : null,
    sponsored: market.sponsored === true,
    placement: 'organic',
    label: null,
  };
}

/** Ids must be unique: the stable tie-break and the comparison labels are keyed by id. */
export function assertUniqueIds(markets: readonly MarketInput[]): void {
  const seen = new Set<string>();
  for (const market of markets) {
    if (typeof market.id !== 'string' || market.id === '')
      fail('every market needs a non-empty string id');
    if (seen.has(market.id)) fail(`duplicate market id ${JSON.stringify(market.id)}`);
    seen.add(market.id);
  }
}
