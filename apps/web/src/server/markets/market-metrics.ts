import type { EvidenceBadge, MarketMetricDto } from '@simplexd/contracts';
import {
  METRIC_KEYS,
  unitsMatch,
  type GeographicLevel,
  type InputKind,
  type MetricInput,
  type MetricKey,
  type SourceQuality,
} from '@simplexd/domain/ranking';
import {
  isLocalLevel,
  observationBadge,
  observationDate,
  observationFreshness,
  observationSourceQuality,
  observationValidUntil,
  toGeographicLevel,
  type Freshness,
} from './evidence';
import {
  BUILD_RATE_METRIC,
  COST_EVIDENCE_METRICS,
  COST_PER_M2_UNIT,
  LAND_PRICE_METRIC,
  OBSERVATION_METRICS_BY_RANKING_METRIC,
  RANKING_METRIC_UNITS,
  RENT_EVIDENCE_METRICS,
} from './metric-map';
import type { FreshnessPolicyMap } from './policy';
import type { ObservationRecord } from './types';

/**
 * Turns a market's local observations into (a) the `metrics` block of the
 * market DTO and (b) the metric inputs the ranking engine scores.
 *
 * Only rank-eligible, published, current interpretations at city,
 * neighbourhood or site level qualify. Statewide context is never copied in;
 * every other metric stays null. Missing values never become zero prices.
 */

export interface DerivationOptions {
  asOf: Date;
  policies: FreshnessPolicyMap;
  /** The user's land area, needed to combine a land price with a build rate. */
  landAreaM2?: number | null;
  /** The user's gross floor area, needed for cost per m² and total cost. */
  floorAreaM2?: number | null;
  /** Pass stale inputs to the engine as well (they stay ineligible, but are explained). */
  includeStale?: boolean;
}

export interface EvidenceDerivation {
  metrics: Record<string, MarketMetricDto | null>;
  inputs: Partial<Record<MetricKey, MetricInput>>;
  hasLocalCostEvidence: boolean;
  hasLocalRentEvidence: boolean;
  totalCostEvidence: MetricInput | null;
}

interface Candidate {
  record: ObservationRecord;
  value: number;
  unit: string;
  freshness: Freshness;
  badge: EvidenceBadge;
  kind: InputKind;
  sourceQuality: SourceQuality;
  observedAt: string | null;
  validUntil: string | null;
  level: GeographicLevel;
  sampleSize: number | null;
  cohort: string;
  sourceVersion: string;
}

function toNumber(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Rank-eligible, published, local rows with a usable numeric value. */
export function rankEligibleCandidates(
  local: readonly ObservationRecord[],
  options: DerivationOptions,
): Candidate[] {
  const out: Candidate[] = [];
  for (const record of local) {
    const { observation, interpretation } = record;
    if (!isLocalLevel(observation.geographyLevel)) continue;
    if (interpretation.publicationState !== 'published' || !interpretation.rankEligible) continue;
    if (interpretation.reviewStatus === 'rejected' || interpretation.reviewStatus === 'superseded')
      continue;
    const value = toNumber(observation.valueNumeric);
    if (value === null) continue;
    const freshness = observationFreshness(record, options.policies, options.asOf);
    out.push({
      record,
      value,
      unit: observation.unit,
      freshness,
      badge: observationBadge(record, freshness),
      // The engine judges staleness itself from the dates; the kind is the underlying badge.
      kind: observationBadge(record, 'fresh'),
      sourceQuality: observationSourceQuality(record),
      observedAt: observationDate(observation),
      validUntil: observationValidUntil(record),
      level: toGeographicLevel(observation.geographyLevel),
      sampleSize: observation.sampleSize,
      cohort: interpretation.cohortMapping ?? observation.propertyCohort,
      sourceVersion: `obs:${observation.id}@v${interpretation.version}`,
    });
  }
  return out;
}

/** Fresh first, then the most recent observation date, then the larger sample. */
function preferCandidate(a: Candidate, b: Candidate): number {
  if (a.freshness !== b.freshness) return a.freshness === 'fresh' ? -1 : 1;
  const dateA = a.observedAt ?? '';
  const dateB = b.observedAt ?? '';
  if (dateA !== dateB) return dateA < dateB ? 1 : -1;
  return (b.sampleSize ?? 0) - (a.sampleSize ?? 0);
}

function pick(candidates: readonly Candidate[], metricNames: readonly string[], unit: string) {
  const names = new Set(metricNames.map((m) => m.toLowerCase()));
  return candidates
    .filter((c) => names.has(c.record.observation.metric.toLowerCase()) && unitsMatch(c.unit, unit))
    .sort(preferCandidate)[0];
}

function toMetricDto(metric: string, c: Candidate): MarketMetricDto {
  const { observation, interpretation, source } = c.record;
  const notes = [
    `${observation.statistic} for cohort ${c.cohort}`,
    interpretation.editorialNote ?? '',
  ].filter((n) => n !== '');
  return {
    metric,
    value: c.value,
    unit: c.unit,
    badge: c.badge,
    observedAt: c.observedAt,
    geographyLevel: c.level,
    sourceTitle: source.title,
    sampleSize: c.sampleSize,
    freshness: c.freshness,
    note: notes.join('. '),
  };
}

function toInput(c: Candidate, unit: string, value = c.value): MetricInput {
  return {
    value,
    unit,
    kind: c.kind,
    sourceQuality: c.sourceQuality,
    observedAt: c.observedAt,
    validUntil: c.validUntil,
    geographicLevel: c.level,
    sampleSize: c.sampleSize,
    cohort: c.cohort,
    sourceVersion: c.sourceVersion,
  };
}

const LEVEL_RANK: Record<GeographicLevel, number> = {
  site: 0,
  neighborhood: 1,
  city: 2,
  state_or_fct: 3,
  country: 4,
};

const QUALITY_RANK: Record<SourceQuality, number> = {
  first_party_verified: 0,
  licensed_dataset: 1,
  official_publication: 2,
  published_report_read: 3,
  unverified_lead: 4,
  user_assumption: 5,
};

/** Combines a land price and a build rate into one input, taking the weaker attributes of the pair. */
function combineCostInputs(
  land: Candidate,
  build: Candidate,
  value: number,
  unit: string,
): MetricInput {
  const older = (land.observedAt ?? '') <= (build.observedAt ?? '') ? land : build;
  const kind: InputKind =
    land.kind === 'verified_operational_record' && build.kind === 'verified_operational_record'
      ? 'verified_operational_record'
      : land.kind === 'disputed' || build.kind === 'disputed'
        ? 'disputed'
        : 'sourced_observation';
  const quality =
    QUALITY_RANK[land.sourceQuality] >= QUALITY_RANK[build.sourceQuality]
      ? land.sourceQuality
      : build.sourceQuality;
  const level = LEVEL_RANK[land.level] >= LEVEL_RANK[build.level] ? land.level : build.level;
  const sample =
    land.sampleSize === null || build.sampleSize === null
      ? null
      : Math.min(land.sampleSize, build.sampleSize);
  return {
    value,
    unit,
    kind,
    sourceQuality: quality,
    observedAt: older.observedAt,
    validUntil: [land.validUntil, build.validUntil].filter((v) => v !== null).sort()[0] ?? null,
    geographicLevel: level,
    sampleSize: sample,
    cohort: land.cohort === build.cohort ? land.cohort : undefined,
    sourceVersion: `${land.sourceVersion}+${build.sourceVersion}`,
  };
}

export function deriveEvidence(
  local: readonly ObservationRecord[],
  options: DerivationOptions,
): EvidenceDerivation {
  const candidates = rankEligibleCandidates(local, options);
  const usable = (c: Candidate | undefined): c is Candidate =>
    c !== undefined && (c.freshness === 'fresh' || options.includeStale === true);
  const metrics: Record<string, MarketMetricDto | null> = {};
  const inputs: Partial<Record<MetricKey, MetricInput>> = {};

  for (const key of METRIC_KEYS) {
    const unit = RANKING_METRIC_UNITS[key];
    const chosen = pick(candidates, OBSERVATION_METRICS_BY_RANKING_METRIC[key], unit);
    metrics[key] = chosen ? toMetricDto(key, chosen) : null;
    if (usable(chosen)) inputs[key] = toInput(chosen, unit);
  }

  const land = pick(candidates, [LAND_PRICE_METRIC], COST_PER_M2_UNIT);
  const build = pick(candidates, [BUILD_RATE_METRIC], COST_PER_M2_UNIT);
  metrics[LAND_PRICE_METRIC] = land ? toMetricDto(LAND_PRICE_METRIC, land) : null;
  metrics[BUILD_RATE_METRIC] = build ? toMetricDto(BUILD_RATE_METRIC, build) : null;

  const landArea = options.landAreaM2 ?? null;
  const floorArea = options.floorAreaM2 ?? null;
  let totalCostEvidence: MetricInput | null = null;
  if (usable(land) && usable(build) && landArea !== null && floorArea !== null && floorArea > 0) {
    const total = land.value * landArea + build.value * floorArea;
    if (total > 0) {
      if (!inputs.affordability) {
        inputs.affordability = combineCostInputs(land, build, total / floorArea, COST_PER_M2_UNIT);
      }
      totalCostEvidence = combineCostInputs(land, build, total, 'NGN');
    }
  } else if (inputs.affordability && floorArea !== null && floorArea > 0) {
    const perM2 = inputs.affordability;
    if (perM2.value > 0)
      totalCostEvidence = { ...perM2, value: perM2.value * floorArea, unit: 'NGN' };
  }

  const fresh = candidates.filter((c) => c.freshness === 'fresh');
  const hasMetric = (names: ReadonlySet<string>): boolean =>
    fresh.some((c) => names.has(c.record.observation.metric.toLowerCase()));

  return {
    metrics,
    inputs,
    hasLocalCostEvidence: hasMetric(COST_EVIDENCE_METRICS),
    hasLocalRentEvidence: hasMetric(RENT_EVIDENCE_METRICS),
    totalCostEvidence,
  };
}
