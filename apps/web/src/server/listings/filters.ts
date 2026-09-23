import {
  listingKindSchema,
  listingTenureSchema,
  propertyKindSchema,
  publicListingSortSchema,
  verificationCheckItemSchema,
  type PublicListingDto,
  type PublicListingFilters,
} from '@simplexd/contracts';
import { isCheckCurrent } from './rules';

/**
 * Public listing filters: tolerant parsing of URL search parameters (an
 * unknown or malformed value is dropped and reported, never an error page)
 * and the matching/sorting applied to the published set. Pure, so the page,
 * the JSON API and the unit tests share one implementation.
 */

export type RawParams =
  | URLSearchParams
  | Record<string, string | string[] | undefined>
  | null
  | undefined;

export interface ParsedListingFilters {
  filters: PublicListingFilters;
  /** Parameter names whose values were not understood and were ignored. */
  ignored: string[];
}

const FILTER_KEYS = [
  'kind',
  'type',
  'minPrice',
  'maxPrice',
  'minArea',
  'maxArea',
  'state',
  'market',
  'tenure',
  'title',
  'available',
  'check',
  'sort',
] as const;

function first(params: RawParams, key: string): string | undefined {
  if (!params) return undefined;
  if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
  const v = params[key];
  return Array.isArray(v) ? v[0] : v;
}

/** Whole naira: digits with optional thousands separators or a leading ₦. */
export function parseNairaParam(raw: string): number | null {
  const cleaned = raw.trim().replace(/^₦/, '').replace(/[,\s_]/g, '');
  if (!/^\d{1,15}$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isSafeInteger(n) ? n : null;
}

/** Square metres: a non-negative decimal. */
export function parseAreaParam(raw: string): number | null {
  const cleaned = raw.trim().replace(/[,\s_]/g, '');
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(cleaned)) return null;
  return Number(cleaned);
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseListingFilters(params: RawParams): ParsedListingFilters {
  const filters: PublicListingFilters = { sort: 'newest' };
  const ignored: string[] = [];
  for (const key of FILTER_KEYS) {
    const raw = first(params, key)?.trim();
    if (raw === undefined || raw === '') continue;
    switch (key) {
      case 'kind': {
        const r = listingKindSchema.safeParse(raw);
        if (r.success) filters.kind = r.data;
        else ignored.push(key);
        break;
      }
      case 'type': {
        const r = propertyKindSchema.safeParse(raw);
        if (r.success) filters.type = r.data;
        else ignored.push(key);
        break;
      }
      case 'minPrice':
      case 'maxPrice': {
        const n = parseNairaParam(raw);
        if (n === null) ignored.push(key);
        else filters[key] = n;
        break;
      }
      case 'minArea':
      case 'maxArea': {
        const n = parseAreaParam(raw);
        if (n === null) ignored.push(key);
        else filters[key] = n;
        break;
      }
      case 'state':
      case 'market': {
        const v = raw.toLowerCase();
        if (SLUG.test(v) && v.length <= 120) filters[key] = v;
        else ignored.push(key);
        break;
      }
      case 'tenure': {
        const r = listingTenureSchema.safeParse(raw);
        if (r.success) filters.tenure = r.data;
        else ignored.push(key);
        break;
      }
      case 'title': {
        if (['disclosed', 'yes', 'true', '1'].includes(raw.toLowerCase())) {
          filters.title = 'disclosed';
        } else ignored.push(key);
        break;
      }
      case 'available': {
        if (raw.toLowerCase() === 'now') filters.available = 'now';
        else ignored.push(key);
        break;
      }
      case 'check': {
        const r = verificationCheckItemSchema.safeParse(raw);
        if (r.success) filters.check = r.data;
        else ignored.push(key);
        break;
      }
      case 'sort': {
        const r = publicListingSortSchema.safeParse(raw);
        if (r.success) filters.sort = r.data;
        else ignored.push(key);
        break;
      }
    }
  }
  // A reversed range is almost always a slip: read it the way it was meant.
  if (
    filters.minPrice !== undefined &&
    filters.maxPrice !== undefined &&
    filters.minPrice > filters.maxPrice
  ) {
    [filters.minPrice, filters.maxPrice] = [filters.maxPrice, filters.minPrice];
  }
  if (
    filters.minArea !== undefined &&
    filters.maxArea !== undefined &&
    filters.minArea > filters.maxArea
  ) {
    [filters.minArea, filters.maxArea] = [filters.maxArea, filters.minArea];
  }
  return { filters, ignored };
}

/** True when any narrowing filter (not just the sort order) is set. */
export function hasActiveFilters(filters: PublicListingFilters): boolean {
  return FILTER_KEYS.some((k) => k !== 'sort' && filters[k] !== undefined);
}

/** Serialises filters back to query parameters (defaults omitted). */
export function filtersToQuery(filters: PublicListingFilters): URLSearchParams {
  const out = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const v = filters[key];
    if (v === undefined) continue;
    if (key === 'sort' && v === 'newest') continue;
    out.set(key, String(v));
  }
  return out;
}

/** Calendar date in Lagos (YYYY-MM-DD) for "available now" comparisons. */
export function lagosDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function isAvailableNow(availability: string | null, now: Date = new Date()): boolean {
  if (!availability) return false;
  if (availability === 'now') return true;
  return /^\d{4}-\d{2}-\d{2}$/.test(availability) && availability <= lagosDate(now);
}

export function matchesListingFilters(
  listing: PublicListingDto,
  f: PublicListingFilters,
  now: Date = new Date(),
): boolean {
  if (f.kind && listing.kind !== f.kind) return false;
  if (f.type && listing.propertyKind !== f.type) return false;
  if (f.minPrice !== undefined || f.maxPrice !== undefined) {
    // "Price on request" cannot satisfy a price range.
    if (listing.priceKobo === null) return false;
    const price = BigInt(listing.priceKobo);
    if (f.minPrice !== undefined && price < BigInt(f.minPrice) * 100n) return false;
    if (f.maxPrice !== undefined && price > BigInt(f.maxPrice) * 100n) return false;
  }
  if (f.minArea !== undefined || f.maxArea !== undefined) {
    if (listing.areaM2 === null) return false;
    const area = Number(listing.areaM2);
    if (f.minArea !== undefined && area < f.minArea) return false;
    if (f.maxArea !== undefined && area > f.maxArea) return false;
  }
  if (f.state && listing.location.stateSlug !== f.state) return false;
  // A listing published at state precision never matches a market filter.
  if (f.market && listing.location.marketSlug !== f.market) return false;
  if (f.tenure && listing.tenure !== f.tenure) return false;
  if (f.title === 'disclosed' && !(listing.titleDisclosure && listing.titleDisclosure.trim()))
    return false;
  if (f.available === 'now' && !isAvailableNow(listing.availability, now)) return false;
  if (f.check) {
    const ok = listing.verification.checks.some(
      (c) => c.item === f.check && c.outcome === 'passed' && isCheckCurrent(c, now),
    );
    if (!ok) return false;
  }
  return true;
}

export function sortListings(
  listings: PublicListingDto[],
  sort: PublicListingFilters['sort'],
): PublicListingDto[] {
  const copy = [...listings];
  const price = (l: PublicListingDto) => (l.priceKobo === null ? null : BigInt(l.priceKobo));
  switch (sort) {
    case 'price_asc':
    case 'price_desc': {
      const dir = sort === 'price_asc' ? 1 : -1;
      // Listings without a stated price always sort last.
      return copy.sort((a, b) => {
        const pa = price(a);
        const pb = price(b);
        if (pa === null && pb === null) return 0;
        if (pa === null) return 1;
        if (pb === null) return -1;
        return pa === pb ? 0 : pa < pb ? -dir : dir;
      });
    }
    case 'area_desc':
      return copy.sort((a, b) => {
        const aa = a.areaM2 === null ? -1 : Number(a.areaM2);
        const ab = b.areaM2 === null ? -1 : Number(b.areaM2);
        return ab - aa;
      });
    default:
      return copy.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
  }
}

export function applyListingFilters(
  listings: PublicListingDto[],
  filters: PublicListingFilters,
  now: Date = new Date(),
): PublicListingDto[] {
  return sortListings(
    listings.filter((l) => matchesListingFilters(l, filters, now)),
    filters.sort,
  );
}
