/**
 * Shared fixtures for the ranking tests. Not part of the public API (not re-exported by index.ts).
 */

import { DEFAULT_FRESHNESS_DAYS, DEFAULT_RANKING_POLICY, metricRecord } from './policy';
import type {
  MarketInput,
  MetricInput,
  MetricKey,
  RankingOptions,
  RankingPolicy,
  RankingResult,
  ScoredMarket,
} from './types';

export const AS_OF = '2026-09-23';

export const baseOptions: RankingOptions = {
  asOf: AS_OF,
  objective: 'long_term_rent',
  mode: 'evidence',
  freshnessDays: DEFAULT_FRESHNESS_DAYS,
};

export function unitOf(metric: MetricKey, policy: RankingPolicy = DEFAULT_RANKING_POLICY): string {
  const bound = policy.metricBounds.find((candidate) => candidate.metric === metric);
  if (!bound) throw new Error(`no bound for ${metric}`);
  return bound.unit;
}

/** Observation date inside every default freshness window (8 days before AS_OF; material quotes allow 14). */
export const OBSERVED_AT = '2026-09-15';

/** A fresh, first-party, city-level sourced observation with a full sample: c = 0.8 under the default rubric. */
export function input(
  metric: MetricKey,
  value: number,
  overrides: Partial<MetricInput> = {},
): MetricInput {
  return {
    value,
    unit: unitOf(metric),
    kind: 'sourced_observation',
    sourceQuality: 'first_party_verified',
    observedAt: OBSERVED_AT,
    geographicLevel: 'city',
    sampleSize: 30,
    ...overrides,
  };
}

/** Site-level variant: c = 1 under the default rubric. */
export function siteInput(
  metric: MetricKey,
  value: number,
  overrides: Partial<MetricInput> = {},
): MetricInput {
  return input(metric, value, { geographicLevel: 'site', ...overrides });
}

/** A user assumption made on the as-of date, city level, no sample: c = 0.5 * 1 * 0.8 * 0.3 = 0.12. */
export function assumption(
  metric: MetricKey,
  value: number,
  overrides: Partial<MetricInput> = {},
): MetricInput {
  return input(metric, value, {
    kind: 'user_assumption',
    sourceQuality: 'user_assumption',
    observedAt: AS_OF,
    sampleSize: null,
    ...overrides,
  });
}

export function market(id: string, overrides: Partial<MarketInput> = {}): MarketInput {
  return {
    id,
    name: id.toUpperCase(),
    metrics: {},
    flags: { floodStatus: 'low', titleStatus: 'verified' },
    hasLocalCostEvidence: true,
    hasLocalRentEvidence: true,
    ...overrides,
  };
}

/** Mid-range values under the default bounds. */
export const MID_VALUES: Record<MetricKey, number> = {
  affordability: 525_000,
  material_access: 6,
  net_rental_economics: 6,
  construction_duration: 300,
  approval_duration: 90,
  evidence_backed_demand: 60,
  infrastructure_site_suitability: 70,
};

export function fullMetrics(
  overrides: Partial<Record<MetricKey, MetricInput | null>> = {},
): Partial<Record<MetricKey, MetricInput | null>> {
  return { ...metricRecord((metric) => input(metric, MID_VALUES[metric])), ...overrides };
}

/** A market with every metric present as fresh, local, first-party evidence. */
export function fullMarket(id: string, overrides: Partial<MarketInput> = {}): MarketInput {
  return market(id, { metrics: fullMetrics(), ...overrides });
}

/** The default policy with the given weights (unlisted metrics weigh 0). */
export function policyWithWeights(
  weights: Partial<Record<MetricKey, number>>,
  overrides: Partial<RankingPolicy> = {},
): RankingPolicy {
  return {
    ...DEFAULT_RANKING_POLICY,
    weights: metricRecord((metric) => weights[metric] ?? 0),
    ...overrides,
  };
}

/** The default policy with one metric's bound replaced. */
export function policyWithBound(
  metric: MetricKey,
  patch: Partial<RankingPolicy['metricBounds'][number]>,
): RankingPolicy {
  return {
    ...DEFAULT_RANKING_POLICY,
    metricBounds: DEFAULT_RANKING_POLICY.metricBounds.map((bound) =>
      bound.metric === metric ? { ...bound, ...patch } : bound,
    ),
  };
}

export function find(result: RankingResult, id: string): ScoredMarket {
  const found = [...result.organic, ...result.excluded].find((candidate) => candidate.id === id);
  if (!found) throw new Error(`market ${id} not in result`);
  return found;
}

export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at index ${index}`);
  return item;
}

export function detail(scored: ScoredMarket, metric: MetricKey): ScoredMarket['metrics'][number] {
  const found = scored.metrics.find((candidate) => candidate.metric === metric);
  if (!found) throw new Error(`no detail for ${metric} on ${scored.id}`);
  return found;
}

export function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
