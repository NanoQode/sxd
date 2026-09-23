import { describe, expect, it } from 'vitest';
import {
  analysePolicy,
  DEFAULT_COVERAGE_THRESHOLD,
  DEFAULT_RANKING_POLICY,
  parseRankingPolicy,
  resolveEffectiveWeights,
  selectBound,
  validateRankingPolicy,
} from './policy';
import { policyWithBound, policyWithWeights, sum } from './test-fixtures';
import { METRIC_KEYS } from './types';
import type { MetricBound, RankingPolicy } from './types';

describe('validateRankingPolicy', () => {
  it('accepts the default policy without errors', () => {
    expect(validateRankingPolicy(DEFAULT_RANKING_POLICY)).toEqual([]);
    expect(analysePolicy(DEFAULT_RANKING_POLICY).disabledMetrics).toEqual([]);
  });

  it('disables a metric whose bounds are equal or inverted, with an admin error', () => {
    const equal = analysePolicy(policyWithBound('affordability', { low: 100, high: 100 }));
    expect(equal.disabledMetrics).toEqual(['affordability']);
    expect(equal.errors).toEqual([
      {
        metric: 'affordability',
        message: expect.stringContaining('high (100) must exceed low (100)'),
      },
    ]);
    const inverted = analysePolicy(policyWithBound('approval_duration', { low: 365, high: 14 }));
    expect(inverted.disabledMetrics).toEqual(['approval_duration']);
  });

  it('disables a metric whose bounds are not finite', () => {
    const nan = analysePolicy(policyWithBound('material_access', { high: Number.NaN }));
    expect(nan.disabledMetrics).toEqual(['material_access']);
    const infinite = analysePolicy(
      policyWithBound('material_access', { low: Number.NEGATIVE_INFINITY }),
    );
    expect(infinite.errors.map((error) => error.metric)).toEqual(['material_access']);
  });

  it('disables a weighted metric that has no bound, and one with a bad weight', () => {
    const noBound: RankingPolicy = {
      ...DEFAULT_RANKING_POLICY,
      metricBounds: DEFAULT_RANKING_POLICY.metricBounds.filter(
        (bound) => bound.metric !== 'evidence_backed_demand',
      ),
    };
    expect(analysePolicy(noBound).disabledMetrics).toEqual(['evidence_backed_demand']);

    const badWeight = policyWithWeights({
      ...DEFAULT_RANKING_POLICY.weights,
      construction_duration: -0.1,
    });
    expect(analysePolicy(badWeight).disabledMetrics).toEqual(['construction_duration']);
    const nanWeight = policyWithWeights({
      ...DEFAULT_RANKING_POLICY.weights,
      construction_duration: Number.NaN,
    });
    expect(analysePolicy(nanWeight).errors[0]?.metric).toBe('construction_duration');
  });

  it('flags duplicate bounds for the same metric and cohort', () => {
    const duplicated: RankingPolicy = {
      ...DEFAULT_RANKING_POLICY,
      metricBounds: [
        ...DEFAULT_RANKING_POLICY.metricBounds,
        { ...DEFAULT_RANKING_POLICY.metricBounds[0]! },
      ],
    };
    const analysis = analysePolicy(duplicated);
    expect(analysis.disabledMetrics).toEqual(['affordability']);
    expect(analysis.errors[0]?.message).toContain('duplicates');
  });

  it('reports invalid rubric factors as policy-wide errors and treats them as 0', () => {
    const broken: RankingPolicy = {
      ...DEFAULT_RANKING_POLICY,
      confidenceRubric: {
        ...DEFAULT_RANKING_POLICY.confidenceRubric,
        sourceQuality: {
          ...DEFAULT_RANKING_POLICY.confidenceRubric.sourceQuality,
          licensed_dataset: 1.5,
        },
      },
    };
    const analysis = analysePolicy(broken);
    expect(analysis.errors).toEqual([
      { metric: null, message: expect.stringContaining('sourceQuality.licensed_dataset') },
    ]);
    expect(analysis.rubric.sourceQuality.licensed_dataset).toBe(0);
    expect(analysis.disabledMetrics).toEqual([]);
  });

  it('falls back to the product default when the coverage threshold is invalid', () => {
    const analysis = analysePolicy({ ...DEFAULT_RANKING_POLICY, coverageThreshold: 7 });
    expect(analysis.coverageThreshold).toBe(DEFAULT_COVERAGE_THRESHOLD);
    expect(analysis.errors[0]?.metric).toBeNull();
  });
});

describe('resolveEffectiveWeights', () => {
  it('renormalises the saved weights to 1 without mutating the policy', () => {
    const before = JSON.stringify(DEFAULT_RANKING_POLICY);
    const resolved = resolveEffectiveWeights(DEFAULT_RANKING_POLICY, {
      objective: 'long_term_rent',
    });
    expect(sum(Object.values(resolved.effectiveWeights))).toBeCloseTo(1, 12);
    expect(resolved.effectiveWeights.affordability).toBeCloseTo(0.25, 12);
    expect(resolved.selectedMetrics).toEqual([...METRIC_KEYS]);
    expect(JSON.stringify(DEFAULT_RANKING_POLICY)).toBe(before);
  });

  it('omits yield for owner occupation and renormalises the rest to 1', () => {
    const resolved = resolveEffectiveWeights(DEFAULT_RANKING_POLICY, {
      objective: 'owner_occupation',
    });
    expect(resolved.omittedMetrics).toEqual(['net_rental_economics']);
    expect(resolved.effectiveWeights.net_rental_economics).toBe(0);
    expect(sum(Object.values(resolved.effectiveWeights))).toBeCloseTo(1, 12);
    expect(resolved.effectiveWeights.affordability).toBeCloseTo(0.25 / 0.8, 12);
    expect(resolved.selectedMetrics).not.toContain('net_rental_economics');
    expect(DEFAULT_RANKING_POLICY.weights.net_rental_economics).toBe(0.2);
  });

  it('applies 0–1 priority overrides before renormalising, clamps them and ignores invalid ones', () => {
    const resolved = resolveEffectiveWeights(DEFAULT_RANKING_POLICY, {
      objective: 'long_term_rent',
      priorityOverrides: {
        affordability: 0.5,
        material_access: 0,
        approval_duration: 4,
        evidence_backed_demand: Number.NaN,
      },
    });
    expect(resolved.appliedOverrides).toEqual({
      affordability: 0.5,
      material_access: 0,
      approval_duration: 1,
    });
    expect(resolved.effectiveWeights.material_access).toBe(0);
    expect(resolved.effectiveWeights.affordability).toBeCloseTo(0.125 / 0.725, 12);
    expect(sum(Object.values(resolved.effectiveWeights))).toBeCloseTo(1, 12);
  });

  it('excludes disabled metrics from the selection', () => {
    const resolved = resolveEffectiveWeights(DEFAULT_RANKING_POLICY, {
      objective: 'commercial',
      disabledMetrics: ['affordability'],
    });
    expect(resolved.effectiveWeights.affordability).toBe(0);
    expect(resolved.effectiveWeights.net_rental_economics).toBeCloseTo(0.2 / 0.75, 12);
  });
});

describe('selectBound', () => {
  const generic: MetricBound = {
    metric: 'affordability',
    direction: 'lower_is_better',
    unit: 'NGN/m2',
    low: 1,
    high: 2,
  };
  const luxury: MetricBound = { ...generic, cohort: 'luxury', low: 5, high: 9 };

  it('prefers the cohort bound and falls back to the cohort-free bound', () => {
    expect(selectBound([generic, luxury], 'luxury')).toBe(luxury);
    expect(selectBound([generic, luxury], 'mid_market')).toBe(generic);
    expect(selectBound([generic, luxury], undefined)).toBe(generic);
    expect(selectBound([luxury], 'mid_market')).toBeUndefined();
  });
});

describe('parseRankingPolicy (zod)', () => {
  it('parses the default policy unchanged', () => {
    expect(parseRankingPolicy(JSON.parse(JSON.stringify(DEFAULT_RANKING_POLICY)))).toEqual(
      DEFAULT_RANKING_POLICY,
    );
  });

  it('rejects malformed policies', () => {
    expect(() => parseRankingPolicy({})).toThrow();
    const { affordability: _dropped, ...weights } = DEFAULT_RANKING_POLICY.weights;
    expect(() => parseRankingPolicy({ ...DEFAULT_RANKING_POLICY, weights })).toThrow();
  });
});
