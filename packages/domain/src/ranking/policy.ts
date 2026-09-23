/**
 * Ranking policy: defaults, validation, bound selection and weight resolution.
 *
 * Brief (quoted): "Build a deterministic, versioned service, not an LLM choosing cities."
 */

import { z } from 'zod';
import { boundProblems, clamp01 } from './normalise';
import { GEOGRAPHIC_LEVELS, METRIC_KEYS, SOURCE_QUALITIES } from './types';
import type {
  ConfidenceRubric,
  MetricBound,
  MetricKey,
  Objective,
  PolicyError,
  RankingPolicy,
} from './types';

/** Product default for the minimum weighted coverage of an investment ranking. */
export const DEFAULT_COVERAGE_THRESHOLD = 0.7;

/**
 * Proposed product defaults, version 1.
 *
 * Brief §6.3 (quoted): "Initial configurable weights: affordability 25%, material delivery/access
 * 15%, net rental economics 20%, construction duration 10%, approval duration 10%, evidence-backed
 * demand 10%, infrastructure/site suitability 10%. These are proposed product defaults, not
 * researched investment truths."
 *
 * The bounds are proposed normalisation anchors for the initial policy version, not researched
 * market facts; the data approver reviews them before a policy version is activated. Bounds are fixed
 * per policy version and never change with the user's viewport. Rubric multipliers are configuration,
 * never hidden judgments.
 */
export const DEFAULT_RANKING_POLICY: RankingPolicy = {
  version: 1,
  weights: {
    affordability: 0.25,
    material_access: 0.15,
    net_rental_economics: 0.2,
    construction_duration: 0.1,
    approval_duration: 0.1,
    evidence_backed_demand: 0.1,
    infrastructure_site_suitability: 0.1,
  },
  metricBounds: [
    // Total development cost per square metre for the user's cohort: lower is better.
    {
      metric: 'affordability',
      direction: 'lower_is_better',
      unit: 'NGN/m2',
      low: 150_000,
      high: 900_000,
    },
    // Delivered material lead time in days: shorter is better.
    { metric: 'material_access', direction: 'lower_is_better', unit: 'days', low: 1, high: 21 },
    // Net yield on development cost in percent: higher is better.
    {
      metric: 'net_rental_economics',
      direction: 'higher_is_better',
      unit: 'percent',
      low: 0,
      high: 12,
    },
    // Scoped construction schedule in days: shorter is better.
    {
      metric: 'construction_duration',
      direction: 'lower_is_better',
      unit: 'days',
      low: 120,
      high: 720,
    },
    // Observed approval duration from the relevant authority in days: shorter is better.
    { metric: 'approval_duration', direction: 'lower_is_better', unit: 'days', low: 14, high: 365 },
    // Index 0–100 from deduplicated comparables and enquiries: higher is better.
    {
      metric: 'evidence_backed_demand',
      direction: 'higher_is_better',
      unit: 'index',
      low: 0,
      high: 100,
    },
    // Index 0–100 from site checks: higher is better. Unknown flood or title status never scores as low risk.
    {
      metric: 'infrastructure_site_suitability',
      direction: 'higher_is_better',
      unit: 'index',
      low: 0,
      high: 100,
    },
  ],
  confidenceRubric: {
    sourceQuality: {
      first_party_verified: 1,
      licensed_dataset: 0.9,
      official_publication: 0.9,
      published_report_read: 0.6,
      unverified_lead: 0.3,
      user_assumption: 0.5,
    },
    freshness: { within_policy: 1, stale: 0 },
    geographicMatch: { site: 1, neighborhood: 0.9, city: 0.8, state_or_fct: 0.4, country: 0.2 },
    sampleSize: {
      thresholds: [
        { min: 30, multiplier: 1 },
        { min: 10, multiplier: 0.8 },
        { min: 3, multiplier: 0.5 },
        { min: 1, multiplier: 0.3 },
      ],
    },
  },
  coverageThreshold: DEFAULT_COVERAGE_THRESHOLD,
  minComparables: 10,
};

/**
 * Proposed freshness windows in days per metric (from the freshness defaults: material quotes 14
 * days or the supplier expiry, rent/sale observations and build rates 90 days, observed permit
 * performance 180 days). `null` means the source's own validity governs, as for official risk
 * layers that are valid until the next edition.
 */
export const DEFAULT_FRESHNESS_DAYS: Record<MetricKey, number | null> = {
  affordability: 90,
  material_access: 14,
  net_rental_economics: 90,
  construction_duration: 90,
  approval_duration: 180,
  evidence_backed_demand: 90,
  infrastructure_site_suitability: null,
};

export function isMetricKey(value: unknown): value is MetricKey {
  return typeof value === 'string' && (METRIC_KEYS as readonly string[]).includes(value);
}

/** Builds a full metric record in canonical key order. */
export function metricRecord<T>(build: (metric: MetricKey) => T): Record<MetricKey, T> {
  const out = {} as Record<MetricKey, T>;
  for (const metric of METRIC_KEYS) out[metric] = build(metric);
  return out;
}

export interface PolicyAnalysis {
  errors: PolicyError[];
  /** Metrics disabled by a metric-specific error, in canonical order. */
  disabledMetrics: MetricKey[];
  /** The rubric with every invalid factor replaced by 0 (each replacement is reported in `errors`). */
  rubric: ConfidenceRubric;
  /** The coverage threshold to apply (the product default when the policy's is invalid). */
  coverageThreshold: number;
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function sanitiseRubric(
  rubric: ConfidenceRubric | undefined,
  push: (metric: MetricKey | null, message: string) => void,
): ConfidenceRubric {
  const sourceQuality = {} as Record<(typeof SOURCE_QUALITIES)[number], number>;
  for (const quality of SOURCE_QUALITIES) {
    const value = rubric?.sourceQuality?.[quality];
    if (isUnitInterval(value)) sourceQuality[quality] = value;
    else {
      push(
        null,
        `confidenceRubric.sourceQuality.${quality} must be a number in [0, 1]; treated as 0`,
      );
      sourceQuality[quality] = 0;
    }
  }
  const geographicMatch = {} as Record<(typeof GEOGRAPHIC_LEVELS)[number], number>;
  for (const level of GEOGRAPHIC_LEVELS) {
    const value = rubric?.geographicMatch?.[level];
    if (isUnitInterval(value)) geographicMatch[level] = value;
    else {
      push(
        null,
        `confidenceRubric.geographicMatch.${level} must be a number in [0, 1]; treated as 0`,
      );
      geographicMatch[level] = 0;
    }
  }
  const freshness = { within_policy: 0, stale: 0 };
  for (const key of ['within_policy', 'stale'] as const) {
    const value = rubric?.freshness?.[key];
    if (isUnitInterval(value)) freshness[key] = value;
    else push(null, `confidenceRubric.freshness.${key} must be a number in [0, 1]; treated as 0`);
  }
  const thresholds: Array<{ min: number; multiplier: number }> = [];
  const rawThresholds = rubric?.sampleSize?.thresholds;
  if (!Array.isArray(rawThresholds)) {
    push(null, 'confidenceRubric.sampleSize.thresholds must be an array; treated as empty');
  } else {
    rawThresholds.forEach((threshold, index) => {
      const minOk =
        typeof threshold?.min === 'number' && Number.isFinite(threshold.min) && threshold.min >= 0;
      if (minOk && isUnitInterval(threshold.multiplier)) {
        thresholds.push({ min: threshold.min, multiplier: threshold.multiplier });
      } else {
        push(
          null,
          `confidenceRubric.sampleSize.thresholds[${index}] must have a non-negative min and a multiplier in [0, 1]; dropped`,
        );
      }
    });
  }
  thresholds.sort((a, b) => b.min - a.min);
  return { sourceQuality, freshness, geographicMatch, sampleSize: { thresholds } };
}

/**
 * Validates a policy and derives what the engine will actually use.
 *
 * Brief (quoted): "Invalid or equal bounds disable that metric with an admin error." A metric is
 * also disabled when its weight is missing, negative or not finite, when it is weighted but has no
 * bound, or when the same metric/cohort has more than one bound (ambiguous configuration).
 */
export function analysePolicy(policy: RankingPolicy): PolicyAnalysis {
  const errors: PolicyError[] = [];
  const disabled = new Set<MetricKey>();
  const push = (metric: MetricKey | null, message: string): void => {
    errors.push({ metric, message });
  };

  if (!Number.isInteger(policy.version) || policy.version < 0) {
    push(null, `version must be a non-negative integer, got ${String(policy.version)}`);
  }

  for (const metric of METRIC_KEYS) {
    const weight = policy.weights?.[metric];
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
      push(metric, `weight must be a finite number >= 0, got ${String(weight)}; metric disabled`);
      disabled.add(metric);
    }
  }

  const bounds = Array.isArray(policy.metricBounds) ? policy.metricBounds : [];
  const seen = new Map<string, number>();
  bounds.forEach((bound, index) => {
    if (!isMetricKey(bound?.metric)) {
      push(
        null,
        `metricBounds[${index}] refers to unknown metric ${JSON.stringify(bound?.metric)}; ignored`,
      );
      return;
    }
    const problems = boundProblems(bound);
    if (problems.length > 0) {
      push(
        bound.metric,
        `metricBounds[${index}] invalid (${problems.join('; ')}); metric disabled`,
      );
      disabled.add(bound.metric);
    }
    const key = `${bound.metric}\u0000${bound.cohort ?? ''}`;
    const previous = seen.get(key);
    if (previous !== undefined) {
      push(
        bound.metric,
        `metricBounds[${index}] duplicates metricBounds[${previous}] for the same cohort; metric disabled`,
      );
      disabled.add(bound.metric);
    } else {
      seen.set(key, index);
    }
  });

  for (const metric of METRIC_KEYS) {
    const weight = policy.weights?.[metric];
    if (disabled.has(metric) || !(typeof weight === 'number' && weight > 0)) continue;
    if (!bounds.some((bound) => bound?.metric === metric)) {
      push(metric, 'no bound configured for a weighted metric; metric disabled');
      disabled.add(metric);
    }
  }

  const rubric = sanitiseRubric(policy.confidenceRubric, push);

  let coverageThreshold = policy.coverageThreshold;
  if (!isUnitInterval(coverageThreshold)) {
    push(
      null,
      `coverageThreshold must be a number in [0, 1], got ${String(coverageThreshold)}; using ${DEFAULT_COVERAGE_THRESHOLD}`,
    );
    coverageThreshold = DEFAULT_COVERAGE_THRESHOLD;
  }
  if (!Number.isInteger(policy.minComparables) || policy.minComparables < 0) {
    push(
      null,
      `minComparables must be a non-negative integer, got ${String(policy.minComparables)}`,
    );
  }

  return {
    errors,
    disabledMetrics: METRIC_KEYS.filter((metric) => disabled.has(metric)),
    rubric,
    coverageThreshold,
  };
}

/** Admin-facing validation: every error the engine would report for this policy. */
export function validateRankingPolicy(policy: RankingPolicy): PolicyError[] {
  return analysePolicy(policy).errors;
}

/**
 * Picks the bound for a cohort: the bound approved for that cohort when one exists, otherwise the
 * cohort-free fallback. Without a requested cohort only the fallback qualifies.
 */
export function selectBound(
  bounds: readonly MetricBound[],
  cohort: string | undefined,
): MetricBound | undefined {
  if (cohort !== undefined) {
    const exact = bounds.find((bound) => bound.cohort === cohort);
    if (exact) return exact;
  }
  return bounds.find((bound) => bound.cohort === undefined || bound.cohort === '');
}

export interface WeightResolutionOptions {
  objective: Objective;
  priorityOverrides?: Partial<Record<MetricKey, number>>;
  disabledMetrics?: readonly MetricKey[];
}

export interface WeightResolution {
  /** Renormalised weights summing to 1 (all zero when nothing is selected). */
  effectiveWeights: Record<MetricKey, number>;
  /** Metrics with a positive effective weight, in canonical order. */
  selectedMetrics: MetricKey[];
  /** Metrics omitted for the objective. */
  omittedMetrics: MetricKey[];
  /** The 0–1 multipliers actually applied (invalid overrides are ignored, not applied). */
  appliedOverrides: Partial<Record<MetricKey, number>>;
}

/**
 * Resolves the weights for one run.
 *
 * Brief (quoted): "For owner-occupier goals omit yield and renormalize the saved weights." The saved
 * policy weights are renormalised into a working copy, never mutated: `net_rental_economics` is
 * dropped for 'owner_occupation' and the remaining weights are scaled to sum to 1. User priority
 * overrides (0–1 multipliers) are applied before renormalising and recorded on the output.
 */
export function resolveEffectiveWeights(
  policy: RankingPolicy,
  options: WeightResolutionOptions,
): WeightResolution {
  const disabled = new Set(options.disabledMetrics ?? []);
  const omittedMetrics: MetricKey[] =
    options.objective === 'owner_occupation' ? ['net_rental_economics'] : [];
  const appliedOverrides: Partial<Record<MetricKey, number>> = {};

  const raw = metricRecord((metric) => {
    const saved = policy.weights?.[metric];
    if (disabled.has(metric) || omittedMetrics.includes(metric)) return 0;
    if (typeof saved !== 'number' || !Number.isFinite(saved) || saved < 0) return 0;
    const override = options.priorityOverrides?.[metric];
    if (typeof override === 'number' && Number.isFinite(override)) {
      const multiplier = clamp01(override);
      appliedOverrides[metric] = multiplier;
      return saved * multiplier;
    }
    return saved;
  });

  const total = METRIC_KEYS.reduce((sum, metric) => sum + raw[metric], 0);
  const effectiveWeights = metricRecord((metric) => (total > 0 ? raw[metric] / total : 0));
  return {
    effectiveWeights,
    selectedMetrics: METRIC_KEYS.filter((metric) => effectiveWeights[metric] > 0),
    omittedMetrics,
    appliedOverrides,
  };
}

// ---------------------------------------------------------------------------------------------
// Optional schema validation for policy objects loaded from storage
// ---------------------------------------------------------------------------------------------

export const metricKeySchema = z.enum(METRIC_KEYS);

export const metricBoundSchema = z.object({
  metric: metricKeySchema,
  direction: z.enum(['higher_is_better', 'lower_is_better']),
  unit: z.string(),
  low: z.number(),
  high: z.number(),
  cohort: z.string().optional(),
});

export const confidenceRubricSchema = z.object({
  sourceQuality: z.record(z.enum(SOURCE_QUALITIES), z.number()),
  freshness: z.object({ within_policy: z.number(), stale: z.number() }),
  geographicMatch: z.record(z.enum(GEOGRAPHIC_LEVELS), z.number()),
  sampleSize: z.object({
    thresholds: z.array(z.object({ min: z.number(), multiplier: z.number() })),
  }),
});

export const rankingPolicySchema = z.object({
  version: z.number().int().nonnegative(),
  weights: z.record(metricKeySchema, z.number()),
  metricBounds: z.array(metricBoundSchema),
  confidenceRubric: confidenceRubricSchema,
  coverageThreshold: z.number().default(DEFAULT_COVERAGE_THRESHOLD),
  minComparables: z.number().int().nonnegative(),
});

/** Parses a stored policy object (shape only; semantic checks are `validateRankingPolicy`). */
export function parseRankingPolicy(value: unknown): RankingPolicy {
  return rankingPolicySchema.parse(value);
}
