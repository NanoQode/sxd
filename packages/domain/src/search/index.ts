/**
 * Property search (build brief §8): saved-search criteria matching and the
 * shortlist comparison model. Pure functions shared by the web app (preview
 * of current matches, shortlist comparison) and the alert job (new matches).
 *
 * Honesty rules:
 *  - a listing whose price or area is not disclosed never matches a price or
 *    area bound (we cannot show it satisfies the bound);
 *  - comparison values come only from the published listing revision or from
 *    what staff recorded on an external shortlist entry, each labelled with
 *    its source; a missing value stays null and is shown as "not disclosed",
 *    never estimated.
 */

export const LISTING_KINDS = ['sale', 'lease', 'short_stay'] as const;
export type ListingKind = (typeof LISTING_KINDS)[number];

export interface SearchCriteria {
  /** Empty or absent: any listing kind. */
  listingKinds?: ListingKind[];
  /** Property kinds (land, residential, commercial ...). Empty: any. */
  propertyKinds?: string[];
  /** Integer kobo as decimal strings. */
  minPriceKobo?: string | null;
  maxPriceKobo?: string | null;
  minAreaM2?: number | null;
  maxAreaM2?: number | null;
  /** Market ids; empty: any market. */
  marketIds?: string[];
  /** State ids; empty: any state. A listing matches when its market or state is listed. */
  stateIds?: string[];
  /** Only listings that disclose their tenure. */
  requireTenureDisclosed?: boolean;
  /** Only listings that carry a title disclosure. */
  requireTitleDisclosure?: boolean;
  /**
   * Verification checks the listing's verification scope must include (case
   * insensitive match on the check item, unexpired). Empty: no requirement.
   */
  requiredVerificationChecks?: string[];
  /** Free text matched against the listing title (all words must appear). */
  keywords?: string | null;
}

export interface VerificationCheckFact {
  item: string;
  /** passed | issue_found | inconclusive (listing verification scope). */
  outcome?: string | null;
  result?: string | null;
  checkedBy?: string | null;
  checkedAt?: string | null;
  expiresAt?: string | null;
}

/** What a published listing revision discloses, as seen by the matcher. */
export interface ListingFacts {
  id: string;
  kind: ListingKind;
  propertyKind: string | null;
  title: string;
  priceKobo: bigint | null;
  areaM2: number | null;
  marketId: string | null;
  stateId: string | null;
  tenure: string | null;
  titleDisclosure: string | null;
  verificationChecks: VerificationCheckFact[];
}

export type CriteriaFailure =
  | 'listing_kind'
  | 'property_kind'
  | 'price_undisclosed'
  | 'price_below_min'
  | 'price_above_max'
  | 'area_undisclosed'
  | 'area_below_min'
  | 'area_above_max'
  | 'location'
  | 'tenure_undisclosed'
  | 'title_disclosure_missing'
  | 'verification_missing'
  | 'keywords';

export interface MatchResult {
  matches: boolean;
  failures: CriteriaFailure[];
}

const present = (v: string | null | undefined): v is string =>
  typeof v === 'string' && v.trim().length > 0;

function toBigInt(v: string | null | undefined): bigint | null {
  if (v === null || v === undefined || v === '') return null;
  if (!/^\d+$/.test(v)) return null;
  return BigInt(v);
}

/**
 * True when an unexpired check whose item contains `term` (case insensitive)
 * is present and did not find an issue.
 */
export function hasVerificationCheck(
  checks: VerificationCheckFact[],
  term: string,
  now: Date = new Date(),
): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  return checks.some((c) => {
    if (!c.item || !c.item.toLowerCase().includes(needle)) return false;
    if (c.outcome === 'issue_found') return false;
    if (c.expiresAt) {
      const exp = new Date(c.expiresAt);
      if (!Number.isNaN(exp.getTime()) && exp <= now) return false;
    }
    return true;
  });
}

/** Evaluates every criterion and reports each one the listing fails. */
export function matchListing(
  criteria: SearchCriteria,
  listing: ListingFacts,
  now: Date = new Date(),
): MatchResult {
  const failures: CriteriaFailure[] = [];
  if (criteria.listingKinds?.length && !criteria.listingKinds.includes(listing.kind)) {
    failures.push('listing_kind');
  }
  if (
    criteria.propertyKinds?.length &&
    (!listing.propertyKind || !criteria.propertyKinds.includes(listing.propertyKind))
  ) {
    failures.push('property_kind');
  }
  const minPrice = toBigInt(criteria.minPriceKobo);
  const maxPrice = toBigInt(criteria.maxPriceKobo);
  if (minPrice !== null || maxPrice !== null) {
    if (listing.priceKobo === null) failures.push('price_undisclosed');
    else {
      if (minPrice !== null && listing.priceKobo < minPrice) failures.push('price_below_min');
      if (maxPrice !== null && listing.priceKobo > maxPrice) failures.push('price_above_max');
    }
  }
  const minArea = criteria.minAreaM2 ?? null;
  const maxArea = criteria.maxAreaM2 ?? null;
  if (minArea !== null || maxArea !== null) {
    if (listing.areaM2 === null || Number.isNaN(listing.areaM2)) failures.push('area_undisclosed');
    else {
      if (minArea !== null && listing.areaM2 < minArea) failures.push('area_below_min');
      if (maxArea !== null && listing.areaM2 > maxArea) failures.push('area_above_max');
    }
  }
  const markets = criteria.marketIds ?? [];
  const states = criteria.stateIds ?? [];
  if (markets.length > 0 || states.length > 0) {
    const inMarket = listing.marketId !== null && markets.includes(listing.marketId);
    const inState = listing.stateId !== null && states.includes(listing.stateId);
    if (!inMarket && !inState) failures.push('location');
  }
  if (criteria.requireTenureDisclosed && !present(listing.tenure)) {
    failures.push('tenure_undisclosed');
  }
  if (criteria.requireTitleDisclosure && !present(listing.titleDisclosure)) {
    failures.push('title_disclosure_missing');
  }
  for (const term of criteria.requiredVerificationChecks ?? []) {
    if (!hasVerificationCheck(listing.verificationChecks, term, now)) {
      failures.push('verification_missing');
      break;
    }
  }
  if (present(criteria.keywords)) {
    const title = listing.title.toLowerCase();
    const words = criteria.keywords
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0);
    if (!words.every((w) => title.includes(w))) failures.push('keywords');
  }
  return { matches: failures.length === 0, failures };
}

/** Human description of a criteria failure (used in previews and staff tooling). */
export const CRITERIA_FAILURE_LABELS: Record<CriteriaFailure, string> = {
  listing_kind: 'Different listing type',
  property_kind: 'Different property type',
  price_undisclosed: 'Price not disclosed',
  price_below_min: 'Below your minimum price',
  price_above_max: 'Above your maximum price',
  area_undisclosed: 'Area not disclosed',
  area_below_min: 'Smaller than your minimum area',
  area_above_max: 'Larger than your maximum area',
  location: 'Outside your chosen locations',
  tenure_undisclosed: 'Tenure not disclosed',
  title_disclosure_missing: 'No title disclosure',
  verification_missing: 'Required verification not in scope',
  keywords: 'Title does not mention your keywords',
};

/** True when the criteria constrain nothing (would match every listing). */
export function isUnconstrained(c: SearchCriteria): boolean {
  return (
    !c.listingKinds?.length &&
    !c.propertyKinds?.length &&
    !present(c.minPriceKobo ?? null) &&
    !present(c.maxPriceKobo ?? null) &&
    (c.minAreaM2 ?? null) === null &&
    (c.maxAreaM2 ?? null) === null &&
    !c.marketIds?.length &&
    !c.stateIds?.length &&
    !c.requireTenureDisclosed &&
    !c.requireTitleDisclosure &&
    !c.requiredVerificationChecks?.length &&
    !present(c.keywords ?? null)
  );
}

/* ---------------------------------------------------------------------- */
/* Shortlist comparison                                                    */
/* ---------------------------------------------------------------------- */

export type ComparisonSource = 'listing' | 'shortlist_entry';

export interface ComparedValue<T> {
  value: T | null;
  /** Where the value came from; null when nothing was disclosed. */
  source: ComparisonSource | null;
}

export interface ListingComparisonFacts {
  priceKobo: bigint | null;
  priceBasis: string | null;
  currency: string;
  areaM2: string | null;
  tenure: string | null;
  titleDisclosure: string | null;
  verificationChecks: VerificationCheckFact[];
  verificationSummary: string | null;
  publicLocationPrecision: string | null;
  marketName: string | null;
  stateName: string | null;
  availability: string | null;
}

export interface ShortlistEntryFacts {
  listingId: string | null;
  externalReference: string | null;
  /** Staff-recorded asking price for external entries only. */
  priceKobo: bigint | null;
}

export interface ComparisonRow {
  price: ComparedValue<string>;
  priceBasis: ComparedValue<string>;
  area: ComparedValue<string>;
  tenure: ComparedValue<string>;
  titleDisclosure: ComparedValue<string>;
  verification: ComparedValue<{ checks: VerificationCheckFact[]; summary: string | null }>;
  locationPrecision: ComparedValue<string>;
  location: ComparedValue<string>;
  availability: ComparedValue<string>;
}

const none = <T>(): ComparedValue<T> => ({ value: null, source: null });
const fromListing = <T>(v: T | null | undefined): ComparedValue<T> =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '')
    ? none<T>()
    : { value: v, source: 'listing' };

/**
 * One column of the side-by-side comparison. A listing-backed entry shows
 * only what the published revision discloses (a listing that is no longer
 * published contributes nothing); an external entry shows only the asking
 * price staff recorded with its source reference. Nothing is inferred.
 */
export function buildComparisonRow(
  entry: ShortlistEntryFacts,
  listing: ListingComparisonFacts | null,
): ComparisonRow {
  if (entry.listingId) {
    if (!listing) {
      return {
        price: none(),
        priceBasis: none(),
        area: none(),
        tenure: none(),
        titleDisclosure: none(),
        verification: none(),
        locationPrecision: none(),
        location: none(),
        availability: none(),
      };
    }
    const location = [listing.marketName, listing.stateName].filter(Boolean).join(', ');
    const hasVerification = listing.verificationChecks.length > 0 || !!listing.verificationSummary;
    return {
      price: fromListing(listing.priceKobo === null ? null : listing.priceKobo.toString()),
      priceBasis: fromListing(listing.priceBasis),
      area: fromListing(listing.areaM2),
      tenure: fromListing(listing.tenure),
      titleDisclosure: fromListing(listing.titleDisclosure),
      verification: hasVerification
        ? {
            value: { checks: listing.verificationChecks, summary: listing.verificationSummary },
            source: 'listing',
          }
        : none(),
      locationPrecision: fromListing(listing.publicLocationPrecision),
      location: fromListing(location || null),
      availability: fromListing(listing.availability),
    };
  }
  return {
    price:
      entry.priceKobo === null
        ? none()
        : { value: entry.priceKobo.toString(), source: 'shortlist_entry' },
    priceBasis: none(),
    area: none(),
    tenure: none(),
    titleDisclosure: none(),
    verification: none(),
    locationPrecision: none(),
    location: none(),
    availability: none(),
  };
}

/** Shortlist entry statuses. */
export const SHORTLIST_ITEM_STATUSES = [
  'candidate',
  'preferred',
  'viewing_requested',
  'viewed',
  'rejected',
  'removed',
] as const;
export type ShortlistItemStatus = (typeof SHORTLIST_ITEM_STATUSES)[number];

/**
 * Shortlist statuses: staff build it (`draft`), share it with the customer
 * (`shared`), the customer accepts it (`accepted`) or staff document the
 * search outcome (`outcome_recorded`). Accepted and outcome-recorded
 * shortlists are frozen.
 */
export const SHORTLIST_STATUSES = ['draft', 'shared', 'accepted', 'outcome_recorded'] as const;
export type ShortlistStatus = (typeof SHORTLIST_STATUSES)[number];

export function isShortlistFrozen(status: string): boolean {
  return status === 'accepted' || status === 'outcome_recorded';
}

export const SEARCH_OUTCOMES = [
  'property_selected',
  'proceeding_to_purchase',
  'no_suitable_property',
  'customer_paused_search',
  'purchased_elsewhere',
] as const;
export type SearchOutcome = (typeof SEARCH_OUTCOMES)[number];
