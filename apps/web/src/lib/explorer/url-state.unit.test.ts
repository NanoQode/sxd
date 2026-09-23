import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTERS,
  buildExploreHref,
  countActiveFilters,
  explorerParsers,
  filtersFromParams,
  hasNonDefaultFilters,
  paramsFromFilters,
  parsePriorities,
  serializePriorities,
  type FilterParams,
} from './url-state';

const defaultParams = (): FilterParams => paramsFromFilters(DEFAULT_FILTERS);

describe('priorities codec', () => {
  it('round-trips valid priorities and drops unknown keys or out-of-range values', () => {
    const encoded = serializePriorities({ affordability: 0.5, net_rental_economics: 1 });
    expect(encoded).toBe('affordability:0.5,net_rental_economics:1');
    expect(parsePriorities(encoded)).toEqual({ affordability: 0.5, net_rental_economics: 1 });
    expect(parsePriorities('bogus:0.4,approval_duration:1.7,material_access:abc')).toEqual({});
    expect(parsePriorities('')).toEqual({});
  });

  it('is exposed as a nuqs parser with an empty default', () => {
    expect(explorerParsers.priorities.parse('affordability:0.25')).toEqual({ affordability: 0.25 });
    expect(explorerParsers.priorities.defaultValue).toEqual({});
  });
});

describe('filtersFromParams', () => {
  it('produces the contract defaults for default params', () => {
    expect(filtersFromParams(defaultParams())).toEqual(DEFAULT_FILTERS);
  });

  it('maps every URL key to its filter and validates ranges', () => {
    const filters = filtersFromParams({
      ...defaultParams(),
      objective: 'commercial',
      budget: 250_000_000,
      land: 600,
      floor: 350,
      asset: 'commercial',
      units: 4,
      spec: 'premium',
      completion: 18,
      yield: 6.5,
      zones: ['SW', 'NC', 'SW'],
      states: ['not-a-uuid', '11111111-1111-4111-8111-111111111111'],
      risk: 'low',
      fresh: 'include_stale',
      unknown: false,
      power: 'required',
      flood: 'exclude_high',
      team: 'available_only',
    });
    expect(filters.objective).toBe('commercial');
    expect(filters.totalBudgetNaira).toBe(250_000_000);
    expect(filters.landAreaM2).toBe(600);
    expect(filters.floorAreaM2).toBe(350);
    expect(filters.assetType).toBe('commercial');
    expect(filters.bedroomsOrUnits).toBe(4);
    expect(filters.qualitySpecification).toBe('premium');
    expect(filters.targetCompletionMonths).toBe(18);
    expect(filters.minProjectedNetYieldPercent).toBe(6.5);
    expect(filters.preferredZones).toEqual(['SW', 'NC']);
    expect(filters.preferredStateIds).toEqual(['11111111-1111-4111-8111-111111111111']);
    expect(filters.riskTolerance).toBe('low');
    expect(filters.evidenceFreshness).toBe('include_stale');
    expect(filters.includeUnknown).toBe(false);
    expect(filters.power).toBe('required');
    expect(filters.floodExposure).toBe('exclude_high');
    expect(filters.serviceTeamAvailability).toBe('available_only');
  });

  it('falls back to null for out-of-range numbers instead of failing', () => {
    const filters = filtersFromParams({
      ...defaultParams(),
      budget: -5,
      units: 700,
      completion: 0,
      yield: 250,
    });
    expect(filters.totalBudgetNaira).toBeNull();
    expect(filters.bedroomsOrUnits).toBeNull();
    expect(filters.targetCompletionMonths).toBeNull();
    expect(filters.minProjectedNetYieldPercent).toBeNull();
  });

  it('round-trips through paramsFromFilters', () => {
    const filters = {
      ...DEFAULT_FILTERS,
      objective: 'student_housing' as const,
      totalBudgetNaira: 80_000_000,
      preferredZones: ['SE' as const],
      floodExposure: 'low_only' as const,
      includeUnknown: false,
    };
    expect(filtersFromParams(paramsFromFilters(filters))).toEqual(filters);
  });
});

describe('href and defaults', () => {
  it('omits default values from the full-explorer link', () => {
    expect(buildExploreHref({ objective: 'long_term_rent', zones: [], view: 'map' })).toBe('/explore');
  });

  it('carries non-default state into the link', () => {
    const href = buildExploreHref({
      objective: 'commercial',
      zones: ['SW', 'NC'],
      market: 'lagos',
      compare: ['lagos', 'ikeja'],
      mode: 'assumption',
      priorities: { affordability: 0.5 },
    });
    expect(href.startsWith('/explore?')).toBe(true);
    const params = new URLSearchParams(href.slice('/explore?'.length));
    expect(params.get('objective')).toBe('commercial');
    expect(params.get('zones')).toBe('SW,NC');
    expect(params.get('market')).toBe('lagos');
    expect(params.get('compare')).toBe('lagos,ikeja');
    expect(params.get('mode')).toBe('assumption');
    expect(params.get('priorities')).toBe('affordability:0.5');
  });

  it('detects whether the URL carries filter state, ignoring selection keys', () => {
    expect(hasNonDefaultFilters({ market: 'lagos', view: 'list' })).toBe(false);
    expect(hasNonDefaultFilters({ objective: 'long_term_rent', zones: [] })).toBe(false);
    expect(hasNonDefaultFilters({ budget: 5_000_000 })).toBe(true);
    expect(hasNonDefaultFilters({ unknown: false })).toBe(true);
  });

  it('counts active filters', () => {
    expect(countActiveFilters(DEFAULT_FILTERS)).toBe(0);
    expect(
      countActiveFilters({ ...DEFAULT_FILTERS, preferredZones: ['SW'], totalBudgetNaira: 1 }),
    ).toBe(2);
  });
});
