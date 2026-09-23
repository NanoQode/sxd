import 'server-only';
import type { SearchListingDto, ShortlistComparisonDto } from '@simplexd/contracts';
import { getDb, systemContext, withActor, type DbExecutor } from '@simplexd/db';
import { buildComparisonRow, type ShortlistEntryFacts } from '@simplexd/domain/search';
import { loadSearchableListings, type SearchableListing } from '@simplexd/notifications';

/**
 * Read-only view of published listings for search and shortlist tooling.
 * Listings are owned by the listings module (apps/web/src/server/listings);
 * this reads the same publicly visible set through the shared loader in
 * @simplexd/notifications (also used by the alert job) under the system
 * context, and exposes public-safe fields only.
 */

export type ListingFactsRow = SearchableListing & { visible: boolean };

export async function loadPublishedListings(opts: {
  now?: Date;
  listingIds?: string[];
  includeHidden?: boolean;
  limit?: number;
}): Promise<ListingFactsRow[]> {
  return withActor(getDb(), systemContext('search-listings'), (tx) =>
    loadSearchableListings(tx, opts),
  );
}

/** Same loader inside an existing transaction (the caller decides the context). */
export function loadPublishedListingsTx(
  tx: DbExecutor,
  opts: { now?: Date; listingIds?: string[]; includeHidden?: boolean; limit?: number },
): Promise<ListingFactsRow[]> {
  return loadSearchableListings(tx, opts);
}

export function toSearchListingDto(l: SearchableListing): SearchListingDto {
  return {
    id: l.id,
    slug: l.slug,
    title: l.title,
    kind: l.kind,
    propertyKind: l.propertyKind,
    priceKobo: l.priceKobo === null ? null : l.priceKobo.toString(),
    priceBasis: l.priceBasis,
    currency: l.currency,
    areaM2: l.areaM2Text,
    tenure: l.tenure,
    titleDisclosure: l.titleDisclosure,
    marketName: l.marketName,
    stateName: l.stateName,
    publicLocationPrecision: l.publicLocationPrecision,
    publishedAt: l.publishedAt?.toISOString() ?? null,
  };
}

/**
 * Comparison column for a shortlist entry. A listing that is no longer
 * publicly visible contributes nothing (its facts may have changed), so the
 * column shows "not disclosed" rather than stale or invented values.
 */
export function comparisonFor(
  entry: ShortlistEntryFacts,
  listing: ListingFactsRow | null,
): ShortlistComparisonDto {
  const facts =
    listing && listing.visible
      ? {
          priceKobo: listing.priceKobo,
          priceBasis: listing.priceBasis,
          currency: listing.currency,
          areaM2: listing.areaM2Text,
          tenure: listing.tenure,
          titleDisclosure: listing.titleDisclosure,
          verificationChecks: listing.verificationChecks,
          verificationSummary: listing.verificationSummary,
          publicLocationPrecision: listing.publicLocationPrecision,
          marketName: listing.marketName,
          stateName: listing.stateName,
          availability: listing.availability,
        }
      : null;
  return buildComparisonRow(entry, facts);
}
