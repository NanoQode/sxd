import { describe, expect, it } from 'vitest';
import type { PublicListingDto } from '@simplexd/contracts';
import {
  applyListingFilters,
  filtersToQuery,
  hasActiveFilters,
  isAvailableNow,
  matchesListingFilters,
  parseAreaParam,
  parseListingFilters,
  parseNairaParam,
} from './filters';

function listing(overrides: Partial<PublicListingDto> = {}): PublicListingDto {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    slug: 'plot-a',
    kind: 'sale',
    propertyKind: 'land',
    title: 'Plot A',
    descriptionHtml: null,
    priceKobo: '1000000000',
    priceBasis: 'outright',
    currency: 'NGN',
    areaM2: '600.00',
    tenure: 'statutory_right_of_occupancy',
    titleDisclosure: 'C of O held',
    availability: 'now',
    availabilityConfirmedAt: null,
    verification: {
      checks: [
        {
          item: 'registry_search',
          label: 'Land registry search',
          outcome: 'passed',
          result: 'clear',
          checkedBy: 'Staff',
          checkedAt: '2026-09-01T00:00:00.000Z',
          expiresAt: '2027-09-01T00:00:00.000Z',
        },
      ],
      summary: null,
    },
    location: {
      precision: 'market',
      stateName: 'Lagos',
      stateSlug: 'lagos',
      marketName: 'Epe',
      marketSlug: 'epe',
      neighborhoodName: null,
      point: null,
    },
    media: [],
    publishedAt: '2026-09-10T00:00:00.000Z',
    expiresAt: '2026-12-09T00:00:00.000Z',
    ...overrides,
  };
}

const now = new Date('2026-09-23T12:00:00Z');

describe('parseListingFilters', () => {
  it('parses every supported parameter from a search-params record', () => {
    const { filters, ignored } = parseListingFilters({
      kind: 'sale',
      type: 'land',
      minPrice: '₦5,000,000',
      maxPrice: '50000000',
      minArea: '500',
      maxArea: '1,200.5',
      state: 'Lagos',
      market: 'epe',
      tenure: 'leasehold',
      title: 'disclosed',
      available: 'now',
      check: 'registry_search',
      sort: 'price_desc',
    });
    expect(ignored).toEqual([]);
    expect(filters).toEqual({
      kind: 'sale',
      type: 'land',
      minPrice: 5_000_000,
      maxPrice: 50_000_000,
      minArea: 500,
      maxArea: 1200.5,
      state: 'lagos',
      market: 'epe',
      tenure: 'leasehold',
      title: 'disclosed',
      available: 'now',
      check: 'registry_search',
      sort: 'price_desc',
    });
  });

  it('drops values it does not understand and reports them instead of failing', () => {
    const { filters, ignored } = parseListingFilters(
      new URLSearchParams(
        'kind=rental&type=castle&minPrice=abc&maxArea=-4&state=La%20gos&tenure=freehold&title=maybe&available=soon&check=vibes&sort=random',
      ),
    );
    expect(ignored).toEqual([
      'kind',
      'type',
      'minPrice',
      'maxArea',
      'state',
      'tenure',
      'title',
      'available',
      'check',
      'sort',
    ]);
    expect(filters).toEqual({ sort: 'newest' });
    expect(hasActiveFilters(filters)).toBe(false);
  });

  it('accepts repeated parameters (first wins), empty values and reversed ranges', () => {
    const { filters, ignored } = parseListingFilters({
      kind: ['lease', 'sale'],
      minPrice: '9000000',
      maxPrice: '1000000',
      minArea: '900',
      maxArea: '100',
      market: '',
      title: 'yes',
    });
    expect(ignored).toEqual([]);
    expect(filters.kind).toBe('lease');
    expect(filters.minPrice).toBe(1_000_000);
    expect(filters.maxPrice).toBe(9_000_000);
    expect(filters.minArea).toBe(100);
    expect(filters.maxArea).toBe(900);
    expect(filters.market).toBeUndefined();
    expect(filters.title).toBe('disclosed');
  });

  it('round-trips through query parameters without defaults', () => {
    const { filters } = parseListingFilters({ kind: 'sale', minPrice: '100', sort: 'newest' });
    expect(filtersToQuery(filters).toString()).toBe('kind=sale&minPrice=100');
    expect(hasActiveFilters(filters)).toBe(true);
    expect(parseListingFilters(null).filters).toEqual({ sort: 'newest' });
  });

  it('parses naira and area inputs strictly', () => {
    expect(parseNairaParam('12,500,000')).toBe(12_500_000);
    expect(parseNairaParam('₦ 1 000')).toBe(1000);
    expect(parseNairaParam('12.5')).toBeNull();
    expect(parseNairaParam('-5')).toBeNull();
    expect(parseAreaParam('1200.55')).toBe(1200.55);
    expect(parseAreaParam('1200.555')).toBeNull();
    expect(parseAreaParam('12e3')).toBeNull();
  });
});

describe('matchesListingFilters', () => {
  it('leaves listings with no stated price or area out of price and area ranges', () => {
    const noPrice = listing({ priceKobo: null, priceBasis: null, areaM2: null });
    expect(matchesListingFilters(noPrice, { sort: 'newest', minPrice: 0 }, now)).toBe(false);
    expect(matchesListingFilters(noPrice, { sort: 'newest', maxArea: 10_000 }, now)).toBe(false);
    expect(matchesListingFilters(noPrice, { sort: 'newest' }, now)).toBe(true);
    expect(
      matchesListingFilters(
        listing(),
        { sort: 'newest', minPrice: 10_000_000, maxPrice: 10_000_000 },
        now,
      ),
    ).toBe(true);
    expect(matchesListingFilters(listing(), { sort: 'newest', maxPrice: 9_999_999 }, now)).toBe(
      false,
    );
    expect(
      matchesListingFilters(listing(), { sort: 'newest', minArea: 600, maxArea: 600 }, now),
    ).toBe(true);
  });

  it('never matches a market filter for a listing published at state precision', () => {
    const stateOnly = listing({
      location: { ...listing().location, precision: 'state', marketName: null, marketSlug: null },
    });
    expect(matchesListingFilters(stateOnly, { sort: 'newest', state: 'lagos' }, now)).toBe(true);
    expect(matchesListingFilters(stateOnly, { sort: 'newest', market: 'epe' }, now)).toBe(false);
    expect(matchesListingFilters(listing(), { sort: 'newest', market: 'epe' }, now)).toBe(true);
  });

  it('matches tenure, title disclosure presence, availability and current passed checks only', () => {
    expect(matchesListingFilters(listing(), { sort: 'newest', tenure: 'leasehold' }, now)).toBe(
      false,
    );
    expect(
      matchesListingFilters(
        listing({ titleDisclosure: '  ' }),
        { sort: 'newest', title: 'disclosed' },
        now,
      ),
    ).toBe(false);
    expect(
      matchesListingFilters(
        listing({ availability: '2026-10-01' }),
        { sort: 'newest', available: 'now' },
        now,
      ),
    ).toBe(false);
    expect(
      matchesListingFilters(
        listing({ availability: '2026-09-01' }),
        { sort: 'newest', available: 'now' },
        now,
      ),
    ).toBe(true);
    expect(
      matchesListingFilters(listing(), { sort: 'newest', check: 'registry_search' }, now),
    ).toBe(true);
    expect(matchesListingFilters(listing(), { sort: 'newest', check: 'site_visit' }, now)).toBe(
      false,
    );
    const lapsed = listing({
      verification: {
        checks: [{ ...listing().verification.checks[0]!, expiresAt: '2026-09-01T00:00:00.000Z' }],
        summary: null,
      },
    });
    expect(matchesListingFilters(lapsed, { sort: 'newest', check: 'registry_search' }, now)).toBe(
      false,
    );
    const failed = listing({
      verification: {
        checks: [{ ...listing().verification.checks[0]!, outcome: 'issue_found' }],
        summary: null,
      },
    });
    expect(matchesListingFilters(failed, { sort: 'newest', check: 'registry_search' }, now)).toBe(
      false,
    );
  });

  it('sorts by price with unpriced listings last, by area and by recency', () => {
    const a = listing({
      id: 'a',
      priceKobo: '300',
      publishedAt: '2026-09-01T00:00:00.000Z',
      areaM2: '10',
    });
    const b = listing({
      id: 'b',
      priceKobo: null,
      publishedAt: '2026-09-03T00:00:00.000Z',
      areaM2: '30',
    });
    const c = listing({
      id: 'c',
      priceKobo: '100',
      publishedAt: '2026-09-02T00:00:00.000Z',
      areaM2: null,
    });
    const ids = (rows: PublicListingDto[]) => rows.map((r) => r.id);
    expect(ids(applyListingFilters([a, b, c], { sort: 'price_asc' }, now))).toEqual([
      'c',
      'a',
      'b',
    ]);
    expect(ids(applyListingFilters([a, b, c], { sort: 'price_desc' }, now))).toEqual([
      'a',
      'c',
      'b',
    ]);
    expect(ids(applyListingFilters([a, b, c], { sort: 'area_desc' }, now))).toEqual([
      'b',
      'a',
      'c',
    ]);
    expect(ids(applyListingFilters([a, b, c], { sort: 'newest' }, now))).toEqual(['b', 'c', 'a']);
  });

  it('reads "available now" in the Lagos calendar day', () => {
    expect(isAvailableNow('now', now)).toBe(true);
    expect(isAvailableNow('2026-09-23', new Date('2026-09-22T23:30:00Z'))).toBe(true);
    expect(isAvailableNow('2026-09-24', now)).toBe(false);
    expect(isAvailableNow(null, now)).toBe(false);
  });
});
