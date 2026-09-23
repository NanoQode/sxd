import 'server-only';
import { cache } from 'react';
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { getDb, schema, systemContext, withActor } from '@simplexd/db';
import { cached } from '@/lib/cache';
import { renderMarkdown } from '@/lib/markdown';

/**
 * Published property listings for the public site. Listings and their
 * published revision are readable anonymously; the owning property row is
 * not (it belongs to a customer organisation), so this module reads through
 * the system context and exposes only public-safe fields: never the address,
 * precise coordinates, owner or organisation.
 */

export interface VerificationCheck {
  item: string;
  checkedBy: string;
  checkedAt: string;
  expiresAt?: string;
  result: string;
}

export interface PublicListing {
  id: string;
  slug: string;
  kind: 'sale' | 'lease' | 'short_stay';
  title: string;
  descriptionHtml: string | null;
  priceKobo: string | null;
  priceBasis: string | null;
  currency: string;
  areaM2: string | null;
  tenure: string | null;
  titleDisclosure: string | null;
  availability: string | null;
  verification: { checks: VerificationCheck[]; summary: string | null } | null;
  publicLocationPrecision: string;
  propertyKind: string;
  marketName: string | null;
  marketSlug: string | null;
  stateName: string | null;
  publishedAt: string | null;
  expiresAt: string | null;
  availabilityConfirmedAt: string | null;
  mediaCount: number;
}

export interface ListingFilters {
  kind?: 'sale' | 'lease' | 'short_stay';
  propertyKind?: string;
}

async function loadListings(): Promise<PublicListing[]> {
  const now = new Date();
  const rows = await withActor(getDb(), systemContext('public-listings'), (tx) =>
    tx
      .select({
        listing: schema.listings,
        revision: schema.listingRevisions,
        propertyKind: schema.properties.kind,
        marketName: schema.markets.name,
        marketSlug: schema.markets.slug,
        stateName: schema.states.name,
      })
      .from(schema.listings)
      .innerJoin(
        schema.listingRevisions,
        and(
          eq(schema.listingRevisions.listingId, schema.listings.id),
          eq(schema.listingRevisions.version, sql`${schema.listings.publishedVersion}`),
        ),
      )
      .innerJoin(schema.properties, eq(schema.properties.id, schema.listings.propertyId))
      .leftJoin(schema.markets, eq(schema.markets.id, schema.properties.marketId))
      .leftJoin(schema.states, eq(schema.states.id, schema.markets.stateId))
      .where(
        and(
          eq(schema.listings.status, 'published'),
          isNull(schema.listings.duplicateOfListingId),
          or(isNull(schema.listings.expiresAt), gt(schema.listings.expiresAt, now)),
        ),
      )
      .orderBy(desc(schema.listings.publishedAt)),
  );
  return rows.map((r) => {
    const scope = r.revision.verificationScope;
    return {
      id: r.listing.id,
      slug: r.listing.slug,
      kind: r.listing.kind,
      title: r.revision.title,
      descriptionHtml: r.revision.descriptionMarkdown
        ? renderMarkdown(r.revision.descriptionMarkdown)
        : null,
      priceKobo: r.revision.priceKobo === null ? null : r.revision.priceKobo.toString(),
      priceBasis: r.revision.priceBasis,
      currency: r.revision.currency,
      areaM2: r.revision.areaM2,
      tenure: r.revision.tenure,
      titleDisclosure: r.revision.titleDisclosure,
      availability: r.revision.availability,
      verification: scope
        ? { checks: Array.isArray(scope.checks) ? scope.checks : [], summary: scope.summary ?? null }
        : null,
      publicLocationPrecision: r.revision.publicLocationPrecision,
      propertyKind: r.propertyKind,
      marketName: r.marketName,
      marketSlug: r.marketSlug,
      stateName: r.stateName,
      publishedAt: r.listing.publishedAt?.toISOString() ?? null,
      expiresAt: r.listing.expiresAt?.toISOString() ?? null,
      availabilityConfirmedAt: r.listing.availabilityConfirmedAt?.toISOString() ?? null,
      mediaCount: Array.isArray(r.revision.mediaFileIds) ? r.revision.mediaFileIds.length : 0,
    };
  });
}

const loadAll = cache(async (): Promise<PublicListing[]> => cached('listings:public:v1', 60, loadListings));

export async function listPublishedListings(filters: ListingFilters = {}): Promise<PublicListing[]> {
  const all = await loadAll();
  return all.filter(
    (l) =>
      (!filters.kind || l.kind === filters.kind) &&
      (!filters.propertyKind || l.propertyKind === filters.propertyKind),
  );
}

export async function getPublishedListing(slug: string): Promise<PublicListing | null> {
  const all = await loadAll();
  return all.find((l) => l.slug === slug) ?? null;
}
