import { describe, expect, it } from 'vitest';
import { DEFAULT_RANKING_POLICY } from './policy';
import { rankMarkets } from './rank';
import {
  assumption,
  at,
  baseOptions,
  detail,
  find,
  fullMarket,
  fullMetrics,
  input,
  market,
  OBSERVED_AT,
  policyWithBound,
  policyWithWeights,
  siteInput,
  sum,
} from './test-fixtures';
import type { MetricInput, RankingOptions } from './types';

describe('fit and coverage arithmetic', () => {
  // Weights 0.4 / 0.3 / 0.3. affordability: s = 1 - (525000 - 150000) / 750000 = 0.5, c = 1 (site,
  // first party, n = 30). net_rental_economics: s = 9 / 12 = 0.75, c = 0.9 * 1 * 0.8 * 0.8 = 0.576
  // (licensed dataset, city, n = 10). approval_duration: absent.
  const policy = policyWithWeights({
    affordability: 0.4,
    net_rental_economics: 0.3,
    approval_duration: 0.3,
  });
  const metrics = {
    affordability: siteInput('affordability', 525_000),
    net_rental_economics: input('net_rental_economics', 9, {
      sourceQuality: 'licensed_dataset',
      sampleSize: 10,
    }),
  };
  const numerator = 0.4 * 0.5 * 1 + 0.3 * 0.75 * 0.576; // 0.3296
  const denominator = 0.4 * 1 + 0.3 * 0.576; // 0.5728

  it('computes fit = 100 * sum(w*s*c) / sum(w*c) and coverage = sum(w eligible) / sum(w selected)', () => {
    const scored = find(rankMarkets([market('a', { metrics })], policy, baseOptions), 'a');
    expect(scored.status).toBe('ranked');
    expect(scored.fit).toBeCloseTo((100 * numerator) / denominator, 9); // 57.5419...
    expect(scored.coverage).toBeCloseTo(0.7, 9);
    expect(scored.confidence).toBeCloseTo((1 + 0.576) / 2, 12);
    expect(scored.eligibleMetrics).toEqual(['affordability', 'net_rental_economics']);
    expect(scored.missing).toEqual(['approval_duration']);
  });

  it('explains the fit with contributions that add up to it, largest first', () => {
    const scored = find(rankMarkets([market('a', { metrics })], policy, baseOptions), 'a');
    expect(sum(scored.contributions.map((c) => c.contribution))).toBeCloseTo(
      scored.fit ?? Number.NaN,
      9,
    );
    expect(at(scored.topContributors, 0)).toMatchObject({
      metric: 'affordability',
      score: 0.5,
      confidence: 1,
    });
    expect(at(scored.topContributors, 0).contribution).toBeCloseTo(
      (100 * 0.4 * 0.5) / denominator,
      9,
    );
    expect(at(scored.topContributors, 0).weight).toBeCloseTo(0.4, 12);
    expect(detail(scored, 'affordability')).toMatchObject({
      badge: 'sourced_observation',
      evidenceDate: OBSERVED_AT,
      evidenceEligible: true,
    });
    expect(detail(scored, 'net_rental_economics').contribution).toBeCloseTo(
      (100 * 0.3 * 0.75 * 0.576) / denominator,
      9,
    );
  });

  it('returns no score when the denominator is zero', () => {
    const scored = find(rankMarkets([market('empty')], policy, baseOptions), 'empty');
    expect(scored.fit).toBeNull();
    expect(scored.status).toBe('more_local_data_needed');
    expect(scored.coverage).toBe(0);
    expect(scored.confidence).toBeNull();
    expect(scored.topContributors).toEqual([]);
    expect(scored.missing).toEqual(['affordability', 'net_rental_economics', 'approval_duration']);
  });

  it('never turns a missing value into a zero price or a perfect score', () => {
    const worst = market('worst', {
      metrics: { ...metrics, approval_duration: siteInput('approval_duration', 365) },
    });
    const best = market('best', {
      metrics: { ...metrics, approval_duration: siteInput('approval_duration', 14) },
    });
    const result = rankMarkets([market('absent', { metrics }), worst, best], policy, baseOptions);
    const absentFit = find(result, 'absent').fit ?? Number.NaN;
    expect(absentFit).toBeCloseTo((100 * numerator) / denominator, 9);
    expect(find(result, 'worst').fit ?? Number.NaN).toBeLessThan(absentFit);
    expect(find(result, 'best').fit ?? Number.NaN).toBeGreaterThan(absentFit);
    expect(detail(find(result, 'absent'), 'approval_duration')).toMatchObject({
      present: false,
      value: null,
      score: null,
      badge: 'unknown',
    });
  });
});

describe('policy bounds inside a ranking', () => {
  it('disables a metric with invalid bounds, reports the admin error and renormalises the rest', () => {
    const result = rankMarkets(
      [fullMarket('a')],
      policyWithBound('affordability', { low: 100, high: 100 }),
      baseOptions,
    );
    expect(result.policyErrors).toEqual([
      { metric: 'affordability', message: expect.stringContaining('metric disabled') },
    ]);
    expect(result.disabledMetrics).toEqual(['affordability']);
    expect(result.effectiveWeights.affordability).toBe(0);
    expect(sum(Object.values(result.effectiveWeights))).toBeCloseTo(1, 12);
    expect(find(result, 'a').metrics.map((m) => m.metric)).not.toContain('affordability');
    expect(find(result, 'a').status).toBe('ranked');
  });

  it('does not change bounds per market: identical inputs get identical scores everywhere', () => {
    const result = rankMarkets(
      [fullMarket('x'), fullMarket('y')],
      DEFAULT_RANKING_POLICY,
      baseOptions,
    );
    expect(find(result, 'x').fit).toBe(find(result, 'y').fit);
  });
});

describe('evidence eligibility inside a ranking', () => {
  it('does not treat statewide medians as local values in either mode', () => {
    const statewide = fullMarket('s', {
      metrics: fullMetrics({
        affordability: input('affordability', 300_000, { geographicLevel: 'state_or_fct' }),
      }),
    });
    const evidence = find(rankMarkets([statewide], DEFAULT_RANKING_POLICY, baseOptions), 's');
    expect(detail(evidence, 'affordability')).toMatchObject({
      evidenceEligible: false,
      assumptionEligible: false,
      ineligibilityReasons: ['statewide_context'],
      geographicScope: 'statewide context',
      score: null,
    });
    expect(evidence.missing).toEqual(['affordability']);
    expect(evidence.coverage).toBeCloseTo(0.75, 12);
    const scenario = find(
      rankMarkets([statewide], DEFAULT_RANKING_POLICY, { ...baseOptions, mode: 'assumption' }),
      's',
    );
    expect(scenario.assumption?.eligibleMetrics).not.toContain('affordability');
  });

  it('does not treat unverified production-plant leads as eligible inputs', () => {
    const lead = fullMarket('l', {
      metrics: fullMetrics({
        material_access: input('material_access', 2, { sourceQuality: 'unverified_lead' }),
      }),
    });
    const scored = find(rankMarkets([lead], DEFAULT_RANKING_POLICY, baseOptions), 'l');
    expect(detail(scored, 'material_access').ineligibilityReasons).toEqual(['unverified_lead']);
    expect(scored.missing).toEqual(['material_access']);
  });

  it('keeps regional context, estimates and assumptions out of the evidence ranking', () => {
    const m = fullMarket('r', {
      metrics: fullMetrics({
        evidence_backed_demand: input('evidence_backed_demand', 90, { kind: 'regional_context' }),
        approval_duration: input('approval_duration', 20, { kind: 'model_estimate' }),
      }),
    });
    const scored = find(rankMarkets([m], DEFAULT_RANKING_POLICY, baseOptions), 'r');
    expect(scored.missing).toEqual(['approval_duration', 'evidence_backed_demand']);
    expect(detail(scored, 'evidence_backed_demand').ineligibilityReasons).toEqual([
      'kind_not_eligible',
    ]);
  });

  it('excludes stale inputs from the default ranking but reports them as stale', () => {
    const m = fullMarket('t', {
      metrics: fullMetrics({
        affordability: input('affordability', 300_000, { observedAt: '2026-05-01' }),
        material_access: input('material_access', 3, {
          observedAt: '2026-09-20',
          validUntil: '2026-09-22',
        }),
      }),
    });
    const scored = find(rankMarkets([m], DEFAULT_RANKING_POLICY, baseOptions), 't');
    expect(detail(scored, 'affordability')).toMatchObject({
      badge: 'stale',
      freshness: 'stale',
      confidence: 0,
      ineligibilityReasons: ['stale'],
    });
    expect(detail(scored, 'material_access')).toMatchObject({
      badge: 'stale',
      validUntil: '2026-09-22',
    });
    expect(scored.missing).toEqual(['affordability', 'material_access']);
    expect(scored.status).toBe('more_local_data_needed'); // coverage 0.6 < 0.7
  });

  it('never normalises an input in a different unit than the policy', () => {
    const m = fullMarket('u', {
      metrics: fullMetrics({ affordability: input('affordability', 30_000, { unit: 'NGN/sqft' }) }),
    });
    const scored = find(rankMarkets([m], DEFAULT_RANKING_POLICY, baseOptions), 'u');
    expect(detail(scored, 'affordability').ineligibilityReasons).toEqual(['unit_mismatch']);
  });
});

describe('investment ranking gates', () => {
  it('requires at least 70% weighted coverage and lists what is missing', () => {
    const thin = fullMarket('thin', {
      metrics: fullMetrics({ material_access: null, net_rental_economics: null }),
    });
    const scored = find(rankMarkets([thin], DEFAULT_RANKING_POLICY, baseOptions), 'thin');
    expect(scored.status).toBe('more_local_data_needed');
    expect(scored.fit).toBeNull();
    expect(scored.coverage).toBeCloseTo(0.65, 12);
    expect(scored.missing).toEqual(['material_access', 'net_rental_economics']);
    expect(scored.topContributors).toEqual([]);

    const enough = fullMarket('enough', { metrics: fullMetrics({ material_access: null }) });
    expect(
      find(rankMarkets([enough], DEFAULT_RANKING_POLICY, baseOptions), 'enough'),
    ).toMatchObject({
      status: 'ranked',
      coverage: expect.closeTo(0.85, 12),
      missing: ['material_access'],
    });
  });

  it('requires locally applicable cost AND rental evidence', () => {
    const noRent = fullMarket('no-rent', { hasLocalRentEvidence: false });
    const noCost = fullMarket('no-cost', { hasLocalCostEvidence: false });
    const result = rankMarkets(
      [noRent, noCost, fullMarket('both')],
      DEFAULT_RANKING_POLICY,
      baseOptions,
    );
    expect(find(result, 'no-rent')).toMatchObject({
      status: 'more_local_data_needed',
      fit: null,
      missing: ['local_rent_evidence'],
    });
    expect(find(result, 'no-cost')).toMatchObject({
      status: 'more_local_data_needed',
      fit: null,
      missing: ['local_cost_evidence'],
    });
    expect(find(result, 'both').status).toBe('ranked');
    expect(result.organic.map((m) => m.id)).toEqual(['both', 'no-cost', 'no-rent']);
    expect(find(result, 'no-rent').rank).toBeNull();
  });

  it('applies the coverage threshold from the policy', () => {
    const strict = { ...DEFAULT_RANKING_POLICY, coverageThreshold: 0.9 };
    const scored = find(
      rankMarkets(
        [fullMarket('e', { metrics: fullMetrics({ material_access: null }) })],
        strict,
        baseOptions,
      ),
      'e',
    );
    expect(scored.status).toBe('more_local_data_needed');
  });

  it('screens without gating when rank is false, marking markets scored rather than ranked', () => {
    const result = rankMarkets(
      [fullMarket('s', { hasLocalRentEvidence: false })],
      DEFAULT_RANKING_POLICY,
      { ...baseOptions, rank: false },
    );
    expect(result.rankingRequested).toBe(false);
    expect(find(result, 's')).toMatchObject({ status: 'scored', missing: ['local_rent_evidence'] });
    expect(find(result, 's').fit).not.toBeNull();
  });
});

describe('owner occupation', () => {
  it('omits yield, renormalises the saved weights and does not require rental evidence', () => {
    const before = JSON.stringify(DEFAULT_RANKING_POLICY);
    const result = rankMarkets(
      [fullMarket('o', { hasLocalRentEvidence: false })],
      DEFAULT_RANKING_POLICY,
      { ...baseOptions, objective: 'owner_occupation' },
    );
    expect(result.omittedMetrics).toEqual(['net_rental_economics']);
    expect(result.effectiveWeights.net_rental_economics).toBe(0);
    expect(sum(Object.values(result.effectiveWeights))).toBeCloseTo(1, 12);
    expect(result.effectiveWeights.affordability).toBeCloseTo(0.3125, 12);
    expect(find(result, 'o').status).toBe('ranked');
    expect(find(result, 'o').metrics.map((m) => m.metric)).not.toContain('net_rental_economics');
    expect(JSON.stringify(DEFAULT_RANKING_POLICY)).toBe(before);
  });
});

describe('user priorities', () => {
  it('applies priority overrides to the policy weights and records the effective weights', () => {
    const result = rankMarkets([fullMarket('p')], DEFAULT_RANKING_POLICY, {
      ...baseOptions,
      priorityOverrides: { affordability: 0.5, material_access: 0 },
    });
    expect(result.priorityOverrides).toEqual({ affordability: 0.5, material_access: 0 });
    expect(result.effectiveWeights.affordability).toBeCloseTo(0.125 / 0.725, 12);
    expect(result.effectiveWeights.material_access).toBe(0);
    expect(sum(Object.values(result.effectiveWeights))).toBeCloseTo(1, 12);
    expect(find(result, 'p').metrics.map((m) => m.metric)).not.toContain('material_access');
    expect(DEFAULT_RANKING_POLICY.weights.affordability).toBe(0.25);
  });
});

describe('hard constraints', () => {
  it('excludes approved geographic exclusions with a reason and keeps them out of the organic list', () => {
    const result = rankMarkets(
      [
        fullMarket('a'),
        fullMarket('g', {
          flags: { floodStatus: 'low', titleStatus: 'verified', geographicExclusion: true },
        }),
      ],
      DEFAULT_RANKING_POLICY,
      baseOptions,
    );
    expect(result.organic.map((m) => m.id)).toEqual(['a']);
    expect(result.excluded.map((m) => m.id)).toEqual(['g']);
    expect(find(result, 'g')).toMatchObject({
      status: 'excluded',
      exclusionReason: 'geographic_exclusion',
      fit: null,
      rank: null,
    });
  });

  it('blocks title stops and site restrictions', () => {
    const result = rankMarkets(
      [
        fullMarket('t', {
          flags: { floodStatus: 'low', titleStatus: 'verified', titleStop: true },
        }),
        fullMarket('s', {
          flags: { floodStatus: 'low', titleStatus: 'verified', siteRestriction: true },
        }),
        fullMarket('b', {
          flags: {
            floodStatus: 'low',
            titleStatus: 'verified',
            titleStop: true,
            siteRestriction: true,
            geographicExclusion: true,
          },
        }),
      ],
      DEFAULT_RANKING_POLICY,
      baseOptions,
    );
    expect(find(result, 't')).toMatchObject({
      status: 'excluded',
      exclusionReason: 'blocked',
      blockedBy: ['title_stop'],
    });
    expect(find(result, 's')).toMatchObject({
      exclusionReason: 'blocked',
      blockedBy: ['site_restriction'],
    });
    expect(find(result, 'b')).toMatchObject({
      exclusionReason: 'geographic_exclusion',
      blockedBy: ['title_stop', 'site_restriction'],
    });
    expect(result.excluded.map((m) => m.id)).toEqual(['b', 's', 't']);
  });

  it('applies the budget ceiling only where cost evidence is valid, and never excludes without it', () => {
    const cost = (value: number, overrides: Partial<MetricInput> = {}): MetricInput => ({
      value,
      unit: 'NGN',
      kind: 'sourced_observation',
      sourceQuality: 'first_party_verified',
      observedAt: '2026-09-01',
      geographicLevel: 'site',
      ...overrides,
    });
    const options: RankingOptions = {
      ...baseOptions,
      budgetCeiling: { amount: 50_000_000, unit: 'NGN' },
    };
    const result = rankMarkets(
      [
        fullMarket('over', { totalCostEvidence: cost(60_000_000) }),
        fullMarket('under', { totalCostEvidence: cost(40_000_000) }),
        fullMarket('none'),
        fullMarket('kobo', { totalCostEvidence: cost(6_000_000_000, { unit: 'kobo' }) }),
        fullMarket('stale', { totalCostEvidence: cost(60_000_000, { observedAt: '2026-01-01' }) }),
        fullMarket('assumed', {
          totalCostEvidence: cost(60_000_000, {
            kind: 'user_assumption',
            sourceQuality: 'user_assumption',
          }),
        }),
      ],
      DEFAULT_RANKING_POLICY,
      options,
    );
    expect(find(result, 'over')).toMatchObject({
      status: 'excluded',
      exclusionReason: 'over_budget',
      budgetAssessable: true,
    });
    expect(find(result, 'under')).toMatchObject({ status: 'ranked', budgetAssessable: true });
    expect(find(result, 'none')).toMatchObject({ status: 'ranked', budgetAssessable: false });
    expect(find(result, 'kobo')).toMatchObject({ status: 'ranked', budgetAssessable: false });
    expect(find(result, 'stale')).toMatchObject({ status: 'ranked', budgetAssessable: false });
    expect(find(result, 'assumed')).toMatchObject({ status: 'ranked', budgetAssessable: false });
    expect(
      find(rankMarkets([fullMarket('n')], DEFAULT_RANKING_POLICY, baseOptions), 'n')
        .budgetAssessable,
    ).toBeNull();
  });

  it('reports unknown flood or title status as unable to assess, never as low risk', () => {
    const result = rankMarkets(
      [
        fullMarket('u', { flags: { floodStatus: 'unknown', titleStatus: 'unknown' } }),
        fullMarket('k', { flags: { floodStatus: 'official_alert', titleStatus: 'issues' } }),
      ],
      DEFAULT_RANKING_POLICY,
      baseOptions,
    );
    expect(find(result, 'u').riskAssessment).toEqual({
      flood: 'unable_to_assess',
      title: 'unable_to_assess',
    });
    expect(find(result, 'k').riskAssessment).toEqual({ flood: 'official_alert', title: 'issues' });
    expect(find(result, 'u').status).toBe('ranked');
  });
});

describe('bidding windows', () => {
  it('exposes the bidding window as information and never scores it', () => {
    const result = rankMarkets(
      [
        fullMarket('short', { biddingWindowDays: 3 }),
        fullMarket('long', { biddingWindowDays: 300 }),
        fullMarket('none'),
      ],
      DEFAULT_RANKING_POLICY,
      baseOptions,
    );
    expect(find(result, 'short').biddingWindowDays).toBe(3);
    expect(find(result, 'long').biddingWindowDays).toBe(300);
    expect(find(result, 'none').biddingWindowDays).toBeNull();
    expect(find(result, 'short').fit).toBe(find(result, 'long').fit);
    expect(result.organic.map((m) => m.id)).toEqual(['long', 'none', 'short']); // pure id tie-break
  });
});

describe('sponsored placements', () => {
  const markets = (sponsored: boolean) => [
    fullMarket('a', { metrics: fullMetrics({ affordability: input('affordability', 200_000) }) }),
    fullMarket('b', {
      sponsored,
      metrics: fullMetrics({ affordability: input('affordability', 500_000) }),
    }),
    fullMarket('c', { metrics: fullMetrics({ affordability: input('affordability', 800_000) }) }),
  ];

  it('returns sponsored markets in a separate labelled array without altering scores or organic order', () => {
    const plain = rankMarkets(markets(false), DEFAULT_RANKING_POLICY, baseOptions);
    const withSponsor = rankMarkets(markets(true), DEFAULT_RANKING_POLICY, baseOptions);
    expect(plain.sponsored).toEqual([]);
    expect(withSponsor.sponsored.map((m) => m.id)).toEqual(['b']);
    expect(at(withSponsor.sponsored, 0)).toMatchObject({
      label: 'Sponsored',
      placement: 'sponsored',
      sponsored: true,
      rank: 2,
    });
    expect(withSponsor.organic.map((m) => [m.id, m.fit, m.rank])).toEqual(
      plain.organic.map((m) => [m.id, m.fit, m.rank]),
    );
    expect(withSponsor.organic.map((m) => m.placement)).toEqual(['organic', 'organic', 'organic']);
    expect(at(withSponsor.sponsored, 0).fit).toBe(find(plain, 'b').fit);
  });

  it('cannot buy a way past hard constraints', () => {
    const result = rankMarkets(
      [
        fullMarket('x', {
          sponsored: true,
          flags: { floodStatus: 'low', titleStatus: 'verified', geographicExclusion: true },
        }),
      ],
      DEFAULT_RANKING_POLICY,
      baseOptions,
    );
    expect(result.sponsored).toEqual([]);
    expect(result.excluded.map((m) => m.id)).toEqual(['x']);
  });
});

describe('ordering', () => {
  it('ranks by fit, then confidence, then id, independent of input order', () => {
    const policy = policyWithWeights({ affordability: 1 });
    const x = market('x', { metrics: { affordability: siteInput('affordability', 525_000) } }); // fit 50, c 1
    const y = market('y', { metrics: { affordability: input('affordability', 525_000) } }); // fit 50, c 0.8
    const a = market('a', { metrics: { affordability: input('affordability', 525_000) } }); // fit 50, c 0.8
    const forward = rankMarkets([y, x, a], policy, baseOptions);
    const backward = rankMarkets([a, x, y], policy, baseOptions);
    expect(forward.organic.map((m) => m.id)).toEqual(['x', 'a', 'y']);
    expect(backward.organic.map((m) => m.id)).toEqual(['x', 'a', 'y']);
    expect(forward.organic.map((m) => m.rank)).toEqual([1, 2, 3]);
    expect(forward.organic.map((m) => m.fit)).toEqual([50, 50, 50]);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(backward));
  });

  it('is deterministic run to run', () => {
    const markets = [
      fullMarket('a'),
      fullMarket('b', { metrics: fullMetrics({ approval_duration: null }) }),
    ];
    expect(JSON.stringify(rankMarkets(markets, DEFAULT_RANKING_POLICY, baseOptions))).toBe(
      JSON.stringify(rankMarkets(markets, DEFAULT_RANKING_POLICY, baseOptions)),
    );
  });
});

describe('assumption mode', () => {
  const assumed = market('u', {
    hasLocalCostEvidence: false,
    hasLocalRentEvidence: false,
    metrics: {
      affordability: assumption('affordability', 525_000),
      material_access: assumption('material_access', 6),
      net_rental_economics: assumption('net_rental_economics', 6),
      construction_duration: assumption('construction_duration', 300),
      approval_duration: assumption('approval_duration', 90),
      evidence_backed_demand: assumption('evidence_backed_demand', 60),
      infrastructure_site_suitability: assumption('infrastructure_site_suitability', 70),
    },
  });

  it('gives assumptions no evidence fit and no assumption fit in evidence mode', () => {
    const result = rankMarkets([assumed], DEFAULT_RANKING_POLICY, baseOptions);
    expect(result.orderedBy).toBe('fit');
    expect(find(result, 'u')).toMatchObject({
      status: 'more_local_data_needed',
      fit: null,
      assumptionFit: null,
      assumption: null,
      rank: null,
    });
    expect(find(result, 'u').missing).toContain('local_cost_evidence');
  });

  it('computes a clearly separate assumptionFit in assumption mode while fit stays gated', () => {
    const result = rankMarkets([assumed, fullMarket('e')], DEFAULT_RANKING_POLICY, {
      ...baseOptions,
      mode: 'assumption',
    });
    expect(result.orderedBy).toBe('assumptionFit');
    const scenario = find(result, 'u');
    expect(scenario.status).toBe('more_local_data_needed');
    expect(scenario.fit).toBeNull();
    expect(scenario.assumptionFit).not.toBeNull();
    expect(scenario.assumption?.coverage).toBeCloseTo(1, 12);
    expect(scenario.assumption?.confidence).toBeCloseTo(0.12, 12); // 0.5 * 1 * 0.8 * 0.3
    expect(scenario.assumption?.topContributors).toHaveLength(3);
    expect(detail(scenario, 'affordability')).toMatchObject({
      badge: 'user_assumption',
      evidenceEligible: false,
      assumptionEligible: true,
    });
    const evidenced = find(result, 'e');
    expect(evidenced.status).toBe('ranked');
    expect(evidenced.assumptionFit).toBe(evidenced.fit);
    expect(result.organic.map((m) => m.rank)).toEqual([1, 2]);
  });

  it('scores an assumption with its rubric multiplier (a single metric cancels c)', () => {
    const result = rankMarkets(
      [market('one', { metrics: { affordability: assumption('affordability', 525_000) } })],
      policyWithWeights({ affordability: 1 }),
      { ...baseOptions, mode: 'assumption' },
    );
    expect(find(result, 'one').assumptionFit).toBeCloseTo(50, 12);
    expect(detail(find(result, 'one'), 'affordability').confidence).toBeCloseTo(0.12, 12);
  });
});

describe('request validation', () => {
  it('rejects malformed requests instead of guessing', () => {
    expect(() =>
      rankMarkets([fullMarket('a')], DEFAULT_RANKING_POLICY, { ...baseOptions, asOf: 'yesterday' }),
    ).toThrow(TypeError);
    expect(() =>
      rankMarkets([fullMarket('a'), fullMarket('a')], DEFAULT_RANKING_POLICY, baseOptions),
    ).toThrow(/duplicate market id/);
    expect(() =>
      rankMarkets([fullMarket('a')], DEFAULT_RANKING_POLICY, {
        ...baseOptions,
        objective: 'flipping' as never,
      }),
    ).toThrow(TypeError);
    expect(() =>
      rankMarkets([fullMarket('a')], DEFAULT_RANKING_POLICY, {
        ...baseOptions,
        freshnessDays: { ...baseOptions.freshnessDays, affordability: -1 },
      }),
    ).toThrow(TypeError);
  });
});
