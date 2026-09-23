import { describe, expect, it } from 'vitest';
import { amenityStatus, applyClientFilters, applyQuery, floodPasses, floodStatusOf } from './filters';
import { market, ranked } from './test-fixtures';
import { DEFAULT_FILTERS } from './url-state';

const metric = (value: number | null, note: string | null = null) => ({
  metric: 'x',
  value,
  unit: null,
  badge: 'sourced_observation' as const,
  observedAt: null,
  geographyLevel: null,
  sourceTitle: null,
  sampleSize: null,
  freshness: 'fresh' as const,
  note,
});

describe('applyClientFilters', () => {
  const lagos = market({ slug: 'lagos', name: 'Lagos', geopoliticalZone: 'SW', aliases: ['Eko'] });
  const kano = market({
    slug: 'kano',
    name: 'Kano',
    stateName: 'Kano',
    geopoliticalZone: 'NW',
    serviceAvailability: 'available',
  });
  const stale = market({
    slug: 'stale-town',
    name: 'Stale Town',
    evidence: { ...lagos.evidence, freshness: 'stale' },
  });
  const all = [lagos, kano, stale];

  it('keeps everything with default filters except stale evidence (fresh_only)', () => {
    expect(applyClientFilters(all, DEFAULT_FILTERS).map((m) => m.slug)).toEqual(['lagos', 'kano']);
    expect(
      applyClientFilters(all, { ...DEFAULT_FILTERS, evidenceFreshness: 'include_stale' }).length,
    ).toBe(3);
  });

  it('filters by preferred zones and states', () => {
    expect(
      applyClientFilters(all, { ...DEFAULT_FILTERS, preferredZones: ['NW'] }).map((m) => m.slug),
    ).toEqual(['kano']);
    expect(
      applyClientFilters(all, { ...DEFAULT_FILTERS, preferredStateIds: [lagos.stateId] }).map(
        (m) => m.slug,
      ),
    ).toEqual(['lagos']);
  });

  it('filters by service team availability', () => {
    expect(
      applyClientFilters(all, { ...DEFAULT_FILTERS, serviceTeamAvailability: 'available_only' }).map(
        (m) => m.slug,
      ),
    ).toEqual(['kano']);
  });

  it('treats unknown flood status as not low risk', () => {
    const withLow = market({
      slug: 'low-flood',
      name: 'Low Flood',
      metrics: { flood_exposure: metric(null, 'Assessed low (official layer)') },
    });
    const withHigh = market({
      slug: 'high-flood',
      name: 'High Flood',
      metrics: { flood_exposure: metric(null, 'High exposure') },
    });
    const markets = [lagos, withLow, withHigh];
    // low_only without unknown: only the assessed-low market
    expect(
      applyClientFilters(markets, {
        ...DEFAULT_FILTERS,
        floodExposure: 'low_only',
        includeUnknown: false,
      }).map((m) => m.slug),
    ).toEqual(['low-flood']);
    // low_only with unknown allowed: unknown stays visible (as unknown), high stays hidden
    expect(
      applyClientFilters(markets, { ...DEFAULT_FILTERS, floodExposure: 'low_only' }).map(
        (m) => m.slug,
      ),
    ).toEqual(['lagos', 'low-flood']);
    expect(
      applyClientFilters(markets, { ...DEFAULT_FILTERS, floodExposure: 'exclude_high' }).map(
        (m) => m.slug,
      ),
    ).toEqual(['lagos', 'low-flood']);
    expect(
      applyClientFilters(markets, { ...DEFAULT_FILTERS, floodExposure: 'unknown_ok' }).map(
        (m) => m.slug,
      ),
    ).toEqual(['lagos', 'low-flood']);
  });

  it('prefers the ranking risk assessment over metric text', () => {
    const r = ranked({
      slug: 'lagos',
      name: 'Lagos',
      marketId: lagos.id,
      riskAssessment: { flood: 'high', title: 'unable_to_assess' },
    });
    expect(floodStatusOf(lagos, r)).toBe('high');
    expect(floodStatusOf(lagos, null)).toBe('unknown');
    expect(
      applyClientFilters([lagos], { ...DEFAULT_FILTERS, floodExposure: 'exclude_high' }, {
        rankedBySlug: new Map([['lagos', r]]),
      }),
    ).toEqual([]);
  });

  it('applies amenity preferences with unknown as a real value', () => {
    const present = market({ slug: 'p', name: 'Present', metrics: { power: metric(1) } });
    const absent = market({ slug: 'a', name: 'Absent', metrics: { power_supply: metric(0) } });
    const unknown = market({ slug: 'u', name: 'Unknown' });
    const markets = [present, absent, unknown];
    expect(amenityStatus(metric(1))).toBe('present');
    expect(amenityStatus(metric(0))).toBe('absent');
    expect(amenityStatus(null)).toBe('unknown');
    expect(
      applyClientFilters(markets, { ...DEFAULT_FILTERS, power: 'required' }).map((m) => m.slug),
    ).toEqual(['p', 'u']);
    expect(
      applyClientFilters(markets, { ...DEFAULT_FILTERS, power: 'required', includeUnknown: false }).map(
        (m) => m.slug,
      ),
    ).toEqual(['p']);
    expect(
      applyClientFilters(markets, { ...DEFAULT_FILTERS, power: 'unknown_ok' }).map((m) => m.slug),
    ).toEqual(['p', 'u']);
    expect(
      applyClientFilters(markets, { ...DEFAULT_FILTERS, power: 'preferred' }).map((m) => m.slug),
    ).toEqual(['p', 'a', 'u']);
  });

  it('never invents a yield: unknown yields pass only when unknown is allowed', () => {
    const known = market({ slug: 'k', name: 'Known', metrics: { net_yield_percent: metric(4) } });
    const unknown = market({ slug: 'u', name: 'Unknown' });
    expect(
      applyClientFilters([known, unknown], {
        ...DEFAULT_FILTERS,
        minProjectedNetYieldPercent: 5,
      }).map((m) => m.slug),
    ).toEqual(['u']);
    expect(
      applyClientFilters([known, unknown], {
        ...DEFAULT_FILTERS,
        minProjectedNetYieldPercent: 3,
        includeUnknown: false,
      }).map((m) => m.slug),
    ).toEqual(['k']);
  });

  it('matches free-text queries against name, state and aliases', () => {
    expect(applyQuery(all, 'eko').map((m) => m.slug)).toEqual(['lagos']);
    expect(applyQuery(all, 'KANO').map((m) => m.slug)).toEqual(['kano']);
    expect(applyQuery(all, '  ').length).toBe(3);
  });

  it('floodPasses encodes the brief rule for every preference', () => {
    expect(floodPasses('unknown', 'low_only', false)).toBe(false);
    expect(floodPasses('unknown', 'low_only', true)).toBe(true);
    expect(floodPasses('official_alert', 'exclude_high', true)).toBe(false);
    expect(floodPasses('moderate', 'unknown_ok', true)).toBe(false);
    expect(floodPasses('high', 'any', false)).toBe(true);
  });
});
