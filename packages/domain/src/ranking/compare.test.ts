import { describe, expect, it } from 'vitest';
import { compareMarkets, detectOverlap, marketsOverlap } from './compare';
import { DEFAULT_RANKING_POLICY } from './policy';
import { at, baseOptions, fullMarket, fullMetrics, input } from './test-fixtures';

describe('compareMarkets', () => {
  const lagos = fullMarket('lagos', {
    metrics: fullMetrics({
      affordability: input('affordability', 400_000, {
        geographicLevel: 'state_or_fct',
        observedAt: '2026-08-15',
      }),
    }),
  });
  const ikeja = fullMarket('ikeja', { parentMarketId: 'lagos', biddingWindowDays: 12 });

  it('labels statewide observations as statewide context, never as a city value', () => {
    const result = compareMarkets([lagos, ikeja], DEFAULT_RANKING_POLICY, baseOptions);
    expect(result.labels.lagos?.affordability).toBe('statewide context');
    expect(result.labels.ikeja?.affordability).toBe('city observation');
    const row = result.rows.find((candidate) => candidate.metric === 'affordability');
    expect(row?.unit).toBe('NGN/m2');
    expect(at(row?.cells ?? [], 0)).toMatchObject({
      marketId: 'lagos',
      geographicScope: 'statewide context',
      geographicLevel: 'state_or_fct',
      evidenceEligible: false,
      score: null,
      ineligibilityReasons: ['statewide_context'],
    });
  });

  it('shows underlying units, evidence dates, confidence and scope per cell', () => {
    const result = compareMarkets([lagos, ikeja], DEFAULT_RANKING_POLICY, baseOptions);
    expect(result.marketIds).toEqual(['lagos', 'ikeja']);
    expect(result.rows).toHaveLength(7);
    const cell = at(at(result.rows, 0).cells, 0);
    expect(cell).toMatchObject({
      value: 400_000,
      unit: 'NGN/m2',
      evidenceDate: '2026-08-15',
      badge: 'sourced_observation',
    });
    expect(cell.confidence).toBeCloseTo(0.4, 12); // 1 * 1 * 0.4 * 1
    expect(at(result.markets, 1)).toMatchObject({
      id: 'ikeja',
      status: 'ranked',
      biddingWindowDays: 12,
    });
    expect(at(result.markets, 0).missing).toEqual(['affordability']);
  });

  it('warns that overlapping markets must not be summed', () => {
    const result = compareMarkets([lagos, ikeja], DEFAULT_RANKING_POLICY, baseOptions);
    expect(result.overlapWarning?.pairs).toEqual([['ikeja', 'lagos']]);
    expect(result.overlapWarning?.message).toContain('must not be summed');
    expect(result.overlapWarning?.message).toContain('ikeja and lagos');
  });

  it('detects overlap through a shared parent or overlap group, and none otherwise', () => {
    const ikorodu = fullMarket('ikorodu', { parentMarketId: 'lagos' });
    expect(detectOverlap([ikeja, ikorodu])?.pairs).toEqual([['ikeja', 'ikorodu']]);
    const grouped = [
      fullMarket('g1', { overlapGroup: 'metro' }),
      fullMarket('g2', { overlapGroup: 'metro' }),
    ];
    expect(marketsOverlap(at(grouped, 0), at(grouped, 1))).toBe(true);
    expect(
      detectOverlap([fullMarket('abuja'), fullMarket('kano', { overlapGroup: '' })]),
    ).toBeNull();
    expect(
      compareMarkets([fullMarket('abuja'), fullMarket('kano')], DEFAULT_RANKING_POLICY, baseOptions)
        .overlapWarning,
    ).toBeNull();
  });

  it('compares at most four markets', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map((id) => fullMarket(id));
    expect(() => compareMarkets(five, DEFAULT_RANKING_POLICY, baseOptions)).toThrow(RangeError);
    expect(
      compareMarkets(five.slice(0, 4), DEFAULT_RANKING_POLICY, baseOptions).markets,
    ).toHaveLength(4);
  });
});
