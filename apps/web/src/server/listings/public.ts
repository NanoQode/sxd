import 'server-only';
import { cache } from 'react';
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import type {
  ListingKind,
  PublicListingDto,
  PublicListingFilters,
  PublicListingLocation,
} from '@simplexd/contracts';
import { getDb, schema, systemContext, withActor, type DbExecutor } from '@simplexd/db';
import { cacheDelete, cached } from '@/lib/cache';
import { precisionOf } from './dto';
import { applyListingFilters } from './filters';
import { isPubliclyVisible, placeSlug, readScope, toCheckDto } from './rules';

/**
 * Published property listings for the public site. The owning property row
 * belongs to a customer organisation and is not publicly readable, so this
 * module reads through the system context and exposes only public-safe
 * fields: never the address, owner, organisation or contact details, and the
 * location only at the precision staff approved (exact coordinates only when
 * that was explicitly approved). A published listing stays live on its
 * approved revision while newer changes are under review; duplicates and
 * lapsed availability windows are never shown.
 */

export type PublicListing = PublicListingDto;
export type VerificationCheck = PublicListingDto['verification']['checks'][number];

const CACHE_PREFIX = 'listings:public';
const CACHE_KEY = `${CACHE_PREFIX}:v2`;

/** Drops the cached public set; called after every publication-affecting change. */
export async function invalidatePublicListings(): Promise<void> {
  await cacheDelete(CACHE_PREFIX);
}

/** Owner-written descriptions: no images or embeds, links marked as user content. */
export function renderListingDescription(markdown: string): string {
  const html = marked.parse(markdown, { async: false, gfm: true, breaks: true }) as string;
  return sanitizeHtml(html, {
    allowedTags: ['p', 'br', 'strong', 'em', 'ul', 'ol', 'li', 'blockquote', 'a', 'h3', 'h4'],
    allowedAttributes: { a: ['href', 'rel'] },
    allowedSchemes: ['https'],
    allowProtocolRelative: false,
    transformTags: {
      h1: 'h3',
      h2: 'h3',
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, rel: 'nofollow ugc noopener noreferrer' },
      }),
    },
  });
}

interface PublicRow {
  listing: typeof schema.listings.$inferSelect;
  revision: typeof schema.listingRevisions.$inferSelect;
  propertyKind: (typeof schema.propertyKindEnum.enumValues)[number];
  location: { lon: number; lat: number } | null;
  marketName: string | null;
  marketSlug: string | null;
  stateName: string | null;
  neighborhoodName: string | null;
}

function buildLocation(r: PublicRow): PublicListingLocation {
  const precision = precisionOf(r.revision.publicLocationPrecision);
  const rank = { state: 0, market: 1, neighborhood: 2, exact: 3 }[precision];
  return {
    precision,
    stateName: r.stateName,
    stateSlug: r.stateName ? placeSlug(r.stateName) : null,
    marketName: rank >= 1 ? r.marketName : null,
    marketSlug: rank >= 1 ? r.marketSlug : null,
    neighborhoodName: rank >= 2 ? r.neighborhoodName : null,
    point:
      rank >= 3 && r.location
        ? {
            lat: Math.round(r.location.lat * 1e5) / 1e5,
            lon: Math.round(r.location.lon * 1e5) / 1e5,
          }
        : null,
  };
}

async function selectPublicRows(tx: DbExecutor, where: ReturnType<typeof and>) {
  return tx
    .select({
      listing: schema.listings,
      revision: schema.listingRevisions,
      propertyKind: schema.properties.kind,
      location: schema.properties.location,
      marketName: schema.markets.name,
      marketSlug: schema.markets.slug,
      stateName: schema.states.name,
      neighborhoodName: schema.neighborhoods.name,
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
    .leftJoin(schema.neighborhoods, eq(schema.neighborhoods.id, schema.properties.neighborhoodId))
    .where(where);
}

/** Publicly approved derivatives (clean images with alt text) among the revision's media. */
async function publicMedia(
  tx: DbExecutor,
  ids: string[],
): Promise<Map<string, { altText: string; caption: string | null }>> {
  const out = new Map<string, { altText: string; caption: string | null }>();
  if (ids.length === 0) return out;
  const rows = await tx
    .select({
      id: schema.fileObjects.id,
      derivatives: schema.fileObjects.derivatives,
      altText: schema.mediaAssets.altText,
      caption: schema.mediaAssets.caption,
    })
    .from(schema.fileObjects)
    .innerJoin(schema.mediaAssets, eq(schema.mediaAssets.fileId, schema.fileObjects.id))
    .where(
      and(
        inArray(schema.fileObjects.id, ids),
        eq(schema.fileObjects.isPublicApproved, true),
        eq(schema.fileObjects.status, 'clean'),
        isNull(schema.fileObjects.deletedAt),
        eq(schema.mediaAssets.approvedForPublic, true),
      ),
    );
  for (const r of rows) {
    if (typeof r.derivatives?.['web'] === 'string') {
      out.set(r.id, { altText: r.altText, caption: r.caption });
    }
  }
  return out;
}

function toPublicDto(
  r: PublicRow,
  media: Map<string, { altText: string; caption: string | null }>,
): PublicListingDto {
  const scope = readScope(r.revision.verificationScope);
  const mediaIds = Array.isArray(r.revision.mediaFileIds) ? r.revision.mediaFileIds : [];
  return {
    id: r.listing.id,
    slug: r.listing.slug,
    kind: r.listing.kind,
    propertyKind: r.propertyKind,
    title: r.revision.title,
    descriptionHtml: r.revision.descriptionMarkdown
      ? renderListingDescription(r.revision.descriptionMarkdown)
      : null,
    priceKobo: r.revision.priceKobo === null ? null : r.revision.priceKobo.toString(),
    priceBasis: r.revision.priceBasis,
    currency: r.revision.currency,
    areaM2: r.revision.areaM2,
    tenure: r.revision.tenure,
    titleDisclosure: r.revision.titleDisclosure,
    availability: r.revision.availability,
    availabilityConfirmedAt: r.listing.availabilityConfirmedAt?.toISOString() ?? null,
    verification: { checks: scope.checks.map(toCheckDto), summary: scope.summary ?? null },
    location: buildLocation(r),
    media: mediaIds.flatMap((id) => {
      const m = media.get(id);
      return m ? [{ fileId: id, altText: m.altText, caption: m.caption }] : [];
    }),
    publishedAt: r.listing.publishedAt?.toISOString() ?? null,
    expiresAt: r.listing.expiresAt?.toISOString() ?? null,
  };
}

/** Candidates for the public set; the time-dependent window is applied per request. */
async function loadCandidates(): Promise<PublicListingDto[]> {
  return withActor(getDb(), systemContext('public-listings'), async (tx) => {
    const rows = await selectPublicRows(
      tx,
      and(
        or(eq(schema.listings.status, 'published'), eq(schema.listings.status, 'in_moderation')),
        isNotNull(schema.listings.publishedVersion),
        isNull(schema.listings.duplicateOfListingId),
      ),
    );
    const allMedia = rows.flatMap((r) =>
      Array.isArray(r.revision.mediaFileIds) ? r.revision.mediaFileIds : [],
    );
    const media = await publicMedia(tx, [...new Set(allMedia)]);
    return rows.map((r) => toPublicDto(r as PublicRow, media));
  });
}

const loadAll = cache(async (): Promise<PublicListingDto[]> =>
  cached(CACHE_KEY, 60, loadCandidates),
);

function visibleNow(l: PublicListingDto, now: Date): boolean {
  return !l.expiresAt || new Date(l.expiresAt).getTime() > now.getTime();
}

/**
 * Published, non-duplicate listings inside their availability window,
 * filtered and sorted. `fresh` bypasses the 60-second cache (tests, APIs
 * right after a moderation decision).
 */
export async function listPublishedListings(
  filters: Partial<PublicListingFilters> = {},
  options: { now?: Date; fresh?: boolean } = {},
): Promise<PublicListingDto[]> {
  const now = options.now ?? new Date();
  const all = options.fresh ? await loadCandidates() : await loadAll();
  return applyListingFilters(
    all.filter((l) => visibleNow(l, now)),
    { sort: 'newest', ...filters },
    now,
  );
}

export async function getPublishedListing(
  slug: string,
  options: { now?: Date; fresh?: boolean } = {},
): Promise<PublicListingDto | null> {
  const all = await listPublishedListings({}, options);
  return all.find((l) => l.slug === slug) ?? null;
}

export type PublicListingState =
  | { state: 'published'; listing: PublicListingDto }
  | {
      state: 'unavailable';
      reason: 'expired' | 'duplicate' | 'withdrawn' | 'closed';
      title: string;
      kind: ListingKind;
      /** The listing this one duplicates, when that one is live. */
      canonicalSlug: string | null;
    }
  | { state: 'not_found' };

/**
 * What the public detail page may say about a slug. Listings that were never
 * published are indistinguishable from unknown slugs; listings that were
 * published once and are no longer live read "no longer available" with the
 * reason category only.
 */
export async function getPublicListingState(
  slug: string,
  options: { now?: Date; fresh?: boolean } = {},
): Promise<PublicListingState> {
  const now = options.now ?? new Date();
  const live = await getPublishedListing(slug, options);
  if (live) return { state: 'published', listing: live };
  return withActor(getDb(), systemContext('public-listing-state'), async (tx) => {
    const [row] = await tx
      .select({
        listing: schema.listings,
        title: schema.listingRevisions.title,
      })
      .from(schema.listings)
      .innerJoin(
        schema.listingRevisions,
        and(
          eq(schema.listingRevisions.listingId, schema.listings.id),
          eq(schema.listingRevisions.version, sql`${schema.listings.publishedVersion}`),
        ),
      )
      .where(eq(schema.listings.slug, slug));
    if (!row || row.listing.publishedVersion === null) return { state: 'not_found' } as const;
    const l = row.listing;
    let canonicalSlug: string | null = null;
    let reason: 'expired' | 'duplicate' | 'withdrawn' | 'closed';
    if (l.duplicateOfListingId) {
      reason = 'duplicate';
      const [target] = await tx
        .select()
        .from(schema.listings)
        .where(eq(schema.listings.id, l.duplicateOfListingId));
      if (target && isPubliclyVisible(target, now)) canonicalSlug = target.slug;
    } else if (l.status === 'withdrawn') {
      reason = 'withdrawn';
    } else if (l.status === 'archived') {
      reason = 'closed';
    } else if (isPubliclyVisible(l, now)) {
      // Live but not yet in the cached set (published seconds ago): read it fresh.
      const fresh = await getPublishedListing(slug, { now, fresh: true });
      if (fresh) return { state: 'published', listing: fresh } as const;
      reason = 'expired';
    } else {
      reason = 'expired';
    }
    return { state: 'unavailable', reason, title: row.title, kind: l.kind, canonicalSlug } as const;
  });
}

/**
 * Minimal public facts about listings (slug, title, owner organisation) for
 * inquiry and offer checks. Reads through the system context because a live
 * listing under change review is not readable by other organisations; only
 * visibility facts leave this function.
 */
export async function loadPublicListingFacts(
  where: { id: string } | { slug: string },
  now: Date = new Date(),
): Promise<{
  id: string;
  slug: string;
  kind: ListingKind;
  organizationId: string;
  propertyId: string;
  title: string;
  visible: boolean;
} | null> {
  return withActor(getDb(), systemContext('public-listing-facts'), async (tx) => {
    const [row] = await tx
      .select({ listing: schema.listings, title: schema.listingRevisions.title })
      .from(schema.listings)
      .leftJoin(
        schema.listingRevisions,
        and(
          eq(schema.listingRevisions.listingId, schema.listings.id),
          eq(schema.listingRevisions.version, sql`${schema.listings.publishedVersion}`),
        ),
      )
      .where(
        'id' in where ? eq(schema.listings.id, where.id) : eq(schema.listings.slug, where.slug),
      );
    if (!row) return null;
    return {
      id: row.listing.id,
      slug: row.listing.slug,
      kind: row.listing.kind,
      organizationId: row.listing.organizationId,
      propertyId: row.listing.propertyId,
      title: row.title ?? '',
      visible: isPubliclyVisible(row.listing, now),
    };
  });
}

/** Distinct states and markets present in the live set, for honest filter options. */
export function locationOptions(listings: PublicListingDto[]): {
  states: Array<{ slug: string; name: string }>;
  markets: Array<{ slug: string; name: string; stateSlug: string | null }>;
} {
  const states = new Map<string, string>();
  const markets = new Map<string, { name: string; stateSlug: string | null }>();
  for (const l of listings) {
    if (l.location.stateSlug && l.location.stateName)
      states.set(l.location.stateSlug, l.location.stateName);
    if (l.location.marketSlug && l.location.marketName)
      markets.set(l.location.marketSlug, {
        name: l.location.marketName,
        stateSlug: l.location.stateSlug,
      });
  }
  return {
    states: [...states]
      .map(([slug, name]) => ({ slug, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    markets: [...markets]
      .map(([slug, v]) => ({ slug, ...v }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
