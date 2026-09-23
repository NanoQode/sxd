/**
 * Eligibility, freshness and confidence for metric inputs.
 *
 * Brief (quoted): "Do not treat statewide mixed-property medians or unverified production-plant
 * leads as eligible inputs. Missing values must not become zero prices or perfect scores."
 */

import { daysBetween, isExpired, parseIsoDate } from './dates';
import { clamp01, unitsMatch } from './normalise';
import type {
  ConfidenceFactors,
  ConfidenceRubric,
  FreshnessStatus,
  GeographicLevel,
  GeographicScopeLabel,
  IneligibilityReason,
  InputKind,
  MetricBound,
  MetricInput,
} from './types';

/** Kinds eligible in the default (evidence) mode. */
export const EVIDENCE_KINDS: readonly InputKind[] = [
  'sourced_observation',
  'verified_operational_record',
];

/** Kinds additionally eligible in the visibly separate assumption mode. */
export const ASSUMPTION_KINDS: readonly InputKind[] = ['user_assumption', 'model_estimate'];

/** Geographic levels that are context, never a local value. */
export const CONTEXT_LEVELS: readonly GeographicLevel[] = ['state_or_fct', 'country'];

/** "A statewide observation must be labeled statewide context, not silently presented as a city value." */
export const GEOGRAPHIC_SCOPE_LABELS: Record<GeographicLevel, GeographicScopeLabel> = {
  site: 'site observation',
  neighborhood: 'neighbourhood observation',
  city: 'city observation',
  state_or_fct: 'statewide context',
  country: 'national context',
};

/**
 * Freshness under the policy window, respecting the source's own `validUntil` when present
 * ("or the supplier expiry, whichever is sooner").
 *
 * - `validUntil` in the past => stale, whatever the age.
 * - `windowDays` a number => `observedAt` is required (missing => undated) and an age beyond the
 *   window is stale.
 * - `windowDays` null => no age limit: fresh while any date (validity or observation) is present.
 *
 * Assumptions and estimates carry the date they were made as `observedAt`; the rule is uniform.
 */
export function evaluateFreshness(
  input: Pick<MetricInput, 'observedAt' | 'validUntil'>,
  windowDays: number | null,
  asOfMs: number,
): FreshnessStatus {
  const validUntil = parseIsoDate(input.validUntil ?? null);
  if (validUntil && isExpired(validUntil, asOfMs)) return 'stale';
  const observed = parseIsoDate(input.observedAt);
  if (windowDays === null) return validUntil || observed ? 'fresh' : 'undated';
  if (!observed) return 'undated';
  return daysBetween(observed.ms, asOfMs) > windowDays ? 'stale' : 'fresh';
}

function factor(value: number | undefined): number {
  // The sanitised rubric already reported invalid factors; anything unexpected contributes nothing.
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return clamp01(value);
}

/**
 * Sample-size factor: thresholds sorted by `min` descending, first threshold reached wins. A
 * null/undefined sample size, or one below every threshold, uses the lowest threshold's multiplier.
 * An empty threshold list means sample size is not part of the rubric (factor 1).
 */
export function sampleSizeFactor(
  sampleSize: number | null | undefined,
  rubric: ConfidenceRubric,
): number {
  const thresholds = [...rubric.sampleSize.thresholds].sort((a, b) => b.min - a.min);
  const lowest = thresholds[thresholds.length - 1];
  if (!lowest) return 1;
  if (typeof sampleSize !== 'number' || !Number.isFinite(sampleSize))
    return factor(lowest.multiplier);
  for (const threshold of thresholds) {
    if (sampleSize >= threshold.min) return factor(threshold.multiplier);
  }
  return factor(lowest.multiplier);
}

/** The four rubric factors for one input. Every factor is configuration, never a hidden judgment. */
export function confidenceFactors(
  input: MetricInput,
  freshness: FreshnessStatus,
  rubric: ConfidenceRubric,
): ConfidenceFactors {
  return {
    sourceQuality: factor(rubric.sourceQuality[input.sourceQuality]),
    freshness:
      freshness === 'fresh'
        ? factor(rubric.freshness.within_policy)
        : factor(rubric.freshness.stale),
    geographicMatch: factor(rubric.geographicMatch[input.geographicLevel]),
    sampleSize: sampleSizeFactor(input.sampleSize, rubric),
  };
}

/** Confidence multiplier c in [0, 1]: the product of the rubric factors. */
export function confidenceMultiplier(factors: ConfidenceFactors): number {
  return clamp01(
    factors.sourceQuality * factors.freshness * factors.geographicMatch * factors.sampleSize,
  );
}

export interface EligibilityQuestion {
  input: MetricInput;
  bound: MetricBound;
  freshness: FreshnessStatus;
  confidence: number;
  /** Normalised score, or null when the value could not be normalised. */
  score: number | null;
  /** Cohort the ranking was requested for, if any. */
  cohort?: string;
}

export interface EligibilityAssessment {
  evidenceEligible: boolean;
  assumptionEligible: boolean;
  evidenceReasons: IneligibilityReason[];
  assumptionReasons: IneligibilityReason[];
}

/**
 * Evidence mode: only 'sourced_observation' and 'verified_operational_record' inputs that are fresh,
 * local (not state/country context), not unverified leads, in the policy unit and with a usable
 * value. Assumption mode additionally admits 'user_assumption' and 'model_estimate' inputs under the
 * same freshness, scope, source and unit rules.
 */
export function assessEligibility(question: EligibilityQuestion): EligibilityAssessment {
  const { input, bound, freshness, confidence, score, cohort } = question;
  const shared: IneligibilityReason[] = [];
  if (score === null) shared.push('invalid_value');
  if (!unitsMatch(input.unit, bound.unit)) shared.push('unit_mismatch');
  if (cohort !== undefined && input.cohort !== undefined && input.cohort !== cohort) {
    shared.push('cohort_mismatch');
  }

  const evidenceKind = EVIDENCE_KINDS.includes(input.kind);
  const assumptionKind = evidenceKind || ASSUMPTION_KINDS.includes(input.kind);
  const evidenceReasons = [...shared];
  const assumptionReasons = [...shared];
  if (!evidenceKind) evidenceReasons.push('kind_not_eligible');
  if (!assumptionKind) assumptionReasons.push('kind_not_eligible');

  const tail: IneligibilityReason[] = [];
  if (freshness === 'undated') tail.push('undated');
  if (freshness === 'stale') tail.push('stale');
  if (CONTEXT_LEVELS.includes(input.geographicLevel)) tail.push('statewide_context');
  if (input.sourceQuality === 'unverified_lead') tail.push('unverified_lead');
  if (freshness === 'fresh' && !(confidence > 0)) tail.push('zero_confidence');
  evidenceReasons.push(...tail);
  assumptionReasons.push(...tail);

  return {
    evidenceEligible: evidenceReasons.length === 0,
    assumptionEligible: assumptionReasons.length === 0,
    evidenceReasons,
    assumptionReasons,
  };
}
