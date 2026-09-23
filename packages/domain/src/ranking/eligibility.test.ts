import { describe, expect, it } from 'vitest';
import { parseIsoDate } from './dates';
import {
  assessEligibility,
  confidenceFactors,
  confidenceMultiplier,
  evaluateFreshness,
  sampleSizeFactor,
} from './eligibility';
import { DEFAULT_RANKING_POLICY } from './policy';
import { input } from './test-fixtures';
import type { MetricBound, MetricInput, MetricKey } from './types';

const asOfMs = Date.UTC(2026, 8, 23);
const rubric = DEFAULT_RANKING_POLICY.confidenceRubric;

describe('evaluateFreshness', () => {
  it('is fresh within the window and stale beyond it (age in whole days, asOf supplied)', () => {
    expect(evaluateFreshness({ observedAt: '2026-09-01' }, 90, asOfMs)).toBe('fresh');
    expect(evaluateFreshness({ observedAt: '2026-06-25' }, 90, asOfMs)).toBe('fresh'); // 90 days
    expect(evaluateFreshness({ observedAt: '2026-06-24' }, 90, asOfMs)).toBe('stale'); // 91 days
    expect(evaluateFreshness({ observedAt: '2026-05-01' }, 90, asOfMs)).toBe('stale');
  });

  it('respects validUntil when present: window or expiry, whichever is sooner', () => {
    expect(
      evaluateFreshness({ observedAt: '2026-09-10', validUntil: '2026-09-20' }, 90, asOfMs),
    ).toBe('stale');
    // A date-only validity covers its whole day.
    expect(
      evaluateFreshness({ observedAt: '2026-09-10', validUntil: '2026-09-23' }, 90, asOfMs),
    ).toBe('fresh');
    expect(
      evaluateFreshness({ observedAt: '2026-01-10', validUntil: '2026-12-31' }, 90, asOfMs),
    ).toBe('stale');
  });

  it('marks undated inputs, and lets a null window defer to the dates present', () => {
    expect(evaluateFreshness({ observedAt: null }, 90, asOfMs)).toBe('undated');
    expect(evaluateFreshness({ observedAt: 'last spring' }, 90, asOfMs)).toBe('undated');
    expect(evaluateFreshness({ observedAt: '2020-01-01' }, null, asOfMs)).toBe('fresh');
    expect(evaluateFreshness({ observedAt: null, validUntil: '2027-01-01' }, null, asOfMs)).toBe(
      'fresh',
    );
    expect(evaluateFreshness({ observedAt: null }, null, asOfMs)).toBe('undated');
  });

  it('reads a date-time without an offset as UTC so the machine time zone never matters', () => {
    expect(parseIsoDate('2026-06-25T00:00:00')?.ms).toBe(Date.UTC(2026, 5, 25));
    expect(parseIsoDate('2026-06-25T01:00:00+01:00')?.ms).toBe(Date.UTC(2026, 5, 25));
    expect(parseIsoDate('2026-06-25')).toEqual({ ms: Date.UTC(2026, 5, 25), dateOnly: true });
    expect(evaluateFreshness({ observedAt: '2026-06-25T00:00:00' }, 90, asOfMs)).toBe('fresh'); // 90 days
    expect(evaluateFreshness({ observedAt: '2026-06-24T00:00:00' }, 90, asOfMs)).toBe('stale'); // 91 days
  });
});

describe('confidence rubric', () => {
  it('matches sample-size thresholds descending and uses the lowest multiplier for a missing sample', () => {
    expect(sampleSizeFactor(30, rubric)).toBe(1);
    expect(sampleSizeFactor(10, rubric)).toBe(0.8);
    expect(sampleSizeFactor(5, rubric)).toBe(0.5);
    expect(sampleSizeFactor(1, rubric)).toBe(0.3);
    expect(sampleSizeFactor(0, rubric)).toBe(0.3);
    expect(sampleSizeFactor(null, rubric)).toBe(0.3);
    expect(sampleSizeFactor(undefined, rubric)).toBe(0.3);
    expect(sampleSizeFactor(null, { ...rubric, sampleSize: { thresholds: [] } })).toBe(1);
  });

  it('multiplies source quality, freshness, geographic match and sample size', () => {
    const observation = input('net_rental_economics', 9, {
      sourceQuality: 'licensed_dataset',
      geographicLevel: 'city',
      sampleSize: 10,
    });
    const factors = confidenceFactors(observation, 'fresh', rubric);
    expect(factors).toEqual({
      sourceQuality: 0.9,
      freshness: 1,
      geographicMatch: 0.8,
      sampleSize: 0.8,
    });
    expect(confidenceMultiplier(factors)).toBeCloseTo(0.576, 12);
    expect(confidenceMultiplier(confidenceFactors(observation, 'stale', rubric))).toBe(0);
    expect(confidenceMultiplier(confidenceFactors(observation, 'undated', rubric))).toBe(0);
  });
});

function requireBound(metric: MetricKey): MetricBound {
  const bound = DEFAULT_RANKING_POLICY.metricBounds.find(
    (candidate) => candidate.metric === metric,
  );
  if (!bound) throw new Error(`fixture: missing ${metric} bound`);
  return bound;
}

describe('assessEligibility', () => {
  const bound = requireBound('affordability');

  function ask(
    overrides: Partial<MetricInput>,
    extra: {
      freshness?: 'fresh' | 'stale' | 'undated';
      confidence?: number;
      score?: number | null;
      cohort?: string;
      bound?: MetricBound;
    } = {},
  ) {
    return assessEligibility({
      input: input('affordability', 500_000, overrides),
      bound: extra.bound ?? bound,
      freshness: extra.freshness ?? 'fresh',
      confidence: extra.confidence ?? 0.8,
      score: extra.score === undefined ? 0.5 : extra.score,
      cohort: extra.cohort,
    });
  }

  it('admits sourced observations and verified operational records in evidence mode', () => {
    expect(ask({ kind: 'sourced_observation' })).toMatchObject({
      evidenceEligible: true,
      assumptionEligible: true,
      evidenceReasons: [],
    });
    expect(ask({ kind: 'verified_operational_record' }).evidenceEligible).toBe(true);
  });

  it('keeps regional context, model estimates and user assumptions out of evidence mode', () => {
    expect(ask({ kind: 'regional_context' })).toMatchObject({
      evidenceEligible: false,
      assumptionEligible: false,
      evidenceReasons: ['kind_not_eligible'],
    });
    expect(ask({ kind: 'model_estimate' })).toMatchObject({
      evidenceEligible: false,
      assumptionEligible: true,
      evidenceReasons: ['kind_not_eligible'],
      assumptionReasons: [],
    });
    expect(ask({ kind: 'user_assumption', sourceQuality: 'user_assumption' })).toMatchObject({
      evidenceEligible: false,
      assumptionEligible: true,
    });
  });

  it('never admits unknown, stale or disputed kinds in either mode', () => {
    for (const kind of ['unknown', 'stale', 'disputed'] as const) {
      expect(ask({ kind })).toMatchObject({ evidenceEligible: false, assumptionEligible: false });
    }
  });

  it('rejects statewide and national context and unverified leads in both modes', () => {
    expect(ask({ geographicLevel: 'state_or_fct' }).evidenceReasons).toEqual(['statewide_context']);
    expect(ask({ geographicLevel: 'country' }).assumptionReasons).toEqual(['statewide_context']);
    expect(ask({ sourceQuality: 'unverified_lead' })).toMatchObject({
      evidenceEligible: false,
      assumptionEligible: false,
      evidenceReasons: ['unverified_lead'],
    });
  });

  it('rejects stale, undated, zero-confidence, mismatched and invalid inputs', () => {
    expect(ask({}, { freshness: 'stale', confidence: 0 }).evidenceReasons).toEqual(['stale']);
    expect(ask({}, { freshness: 'undated', confidence: 0 }).evidenceReasons).toEqual(['undated']);
    expect(ask({}, { confidence: 0 }).evidenceReasons).toEqual(['zero_confidence']);
    expect(ask({ unit: 'NGN/sqft' }).evidenceReasons).toEqual(['unit_mismatch']);
    expect(ask({ cohort: 'luxury' }, { cohort: 'mid_market' }).evidenceReasons).toEqual([
      'cohort_mismatch',
    ]);
    expect(ask({ cohort: 'mid_market' }, { cohort: 'mid_market' }).evidenceEligible).toBe(true);
    expect(ask({}, { score: null }).evidenceReasons).toEqual(['invalid_value']);
  });
});
