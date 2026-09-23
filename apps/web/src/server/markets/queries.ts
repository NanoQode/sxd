import 'server-only';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import {
  ApiError,
  uuidSchema,
  type MarketDetailDto,
  type MarketGeoJson,
  type MarketListQuery,
  type MarketListResponse,
  type MarketObservationsPage,
  type MarketObservationsQuery,
  type ObservationDto,
} from '@simplexd/contracts';
import { getDb, schema, withActor, type DbExecutor } from '@simplexd/db';
import type { RequestIdentity } from '@/lib/auth/session';
import { cached } from '@/lib/cache';
import { visibilityFor, type Visibility } from './access';
import { loadBundles, loadDetailExtras, loadMarketRows, marketPublicationFilter } from './load';
import { toGeoFeature, toMarketDetail, toMarketSummary, toObservationDto } from './mappers';
import { loadReadModelContext, type ReadModelContext } from './policy';
import type { MarketBundle, MarketRow, SourceRow } from './types';

/**
 * Market read model. Visibility: anonymous and customer identities only see
 * published markets and published observation interpretations; staff with
 * market_data.read_drafts may pass includeUnpublished and see draft rows
 * with their states. Every query runs under the caller's row-level security
 * context.
 */

export interface StateWithCounts {
  id: string;
  name: string;
  geopoliticalZone: 'NC' | 'NE' | 'NW' | 'SE' | 'SS' | 'SW';
  isFederalCapital: boolean;
  marketCount: number;
}

interface Bbox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export function parseBbox(raw: string): Bbox {
  const parts = raw.split(',').map(Number);
  const [minLon, minLat, maxLon, maxLat] = parts;
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isFinite(n)) ||
    minLon === undefined ||
    minLat === undefined ||
    maxLon === undefined ||
    maxLat === undefined
  ) {
    throw new ApiError('validation_failed', 'bbox must be minLon,minLat,maxLon,maxLat');
  }
  const ok =
    minLon >= -180 &&
    maxLon <= 180 &&
    minLat >= -90 &&
    maxLat <= 90 &&
    minLon < maxLon &&
    minLat < maxLat;
  if (!ok) throw new ApiError('validation_failed', 'bbox must be a valid WGS84 envelope');
  return { minLon, minLat, maxLon, maxLat };
}

/** Escapes LIKE wildcards so a user's search text is matched literally. */
export function likePattern(text: string): string {
  const escaped = text.replace(/[\\%_]/g, (m) => `\\${m}`);
  return `%${escaped}%`;
}

function listFilters(query: MarketListQuery, visibility: Visibility): SQL[] {
  const where: SQL[] = [marketPublicationFilter(visibility)];
  if (query.bbox) {
    const b = parseBbox(query.bbox);
    // Reviewed parameterised PostGIS predicate: envelope overlaps the market point.
    where.push(
      sql`ST_MakeEnvelope(${b.minLon}, ${b.minLat}, ${b.maxLon}, ${b.maxLat}, 4326) && ${schema.markets.location}`,
    );
  }
  if (query.zone) where.push(eq(schema.markets.geopoliticalZone, query.zone));
  if (query.stateId) where.push(eq(schema.markets.stateId, query.stateId));
  if (query.serviceAvailability)
    where.push(eq(schema.markets.serviceAvailability, query.serviceAvailability));
  if (query.q && query.q.trim() !== '') {
    const pattern = likePattern(query.q.trim());
    where.push(
      sql`(${schema.markets.name} ILIKE ${pattern} ESCAPE '\\' OR EXISTS (SELECT 1 FROM unnest(${schema.markets.aliases}) AS alias WHERE alias ILIKE ${pattern} ESCAPE '\\'))`,
    );
  }
  return where;
}

function matchesEvidenceStatus(
  status: MarketListQuery['evidenceStatus'],
  summary: { localObservations: number; regionalContextObservations: number; freshness: string },
): boolean {
  switch (status) {
    case 'has_local':
      return summary.localObservations > 0;
    case 'has_regional':
      return summary.regionalContextObservations > 0;
    case 'none':
      return summary.localObservations === 0 && summary.regionalContextObservations === 0;
    case 'stale':
      return summary.freshness === 'stale';
    default:
      return true;
  }
}

/**
 * GET /api/v1/markets. `objective` is accepted for deep links but does not
 * restrict the list: no market carries objective-specific evidence yet, and a
 * city can be visible while not eligible for financial ranking.
 */
export async function listMarkets(
  query: MarketListQuery,
  identity: RequestIdentity,
): Promise<MarketListResponse> {
  const visibility = visibilityFor(identity, query.includeUnpublished);
  const asOf = new Date();
  return withActor(getDb(), identity.ctx, async (tx) => {
    const ctx = await loadReadModelContext(tx, asOf);
    const rows = await loadMarketRows(tx, listFilters(query, visibility));
    const bundles = await loadBundles(tx, rows, visibility);
    const summaries = bundles
      .map((bundle) => toMarketSummary(bundle, ctx))
      .filter((summary) => matchesEvidenceStatus(query.evidenceStatus, summary.evidence));
    return {
      items: summaries.slice(0, query.limit),
      total: summaries.length,
      policy: {
        activeRankingPolicyVersion: ctx.activeRankingPolicyVersion,
        defaultFinancialRankingEnabled: ctx.settings.defaultFinancialRankingEnabled,
        coverageThreshold: ctx.settings.coverageThreshold ?? 0.7,
      },
      generatedAt: asOf.toISOString(),
    };
  });
}

/** Resolves a market by UUID or slug under the caller's visibility; null when absent or hidden. */
export async function resolveMarket(
  tx: DbExecutor,
  idOrSlug: string,
  visibility: Visibility,
): Promise<{ market: MarketRow; state: typeof schema.states.$inferSelect } | null> {
  const byId = uuidSchema.safeParse(idOrSlug).success;
  const publication = visibility.readDrafts
    ? sql`${schema.markets.publicationState} <> 'archived'`
    : eq(schema.markets.publicationState, 'published');
  const rows = await loadMarketRows(tx, [
    byId ? eq(schema.markets.id, idOrSlug) : eq(schema.markets.slug, idOrSlug),
    publication,
  ]);
  return rows[0] ?? null;
}

/** GET /api/v1/markets/:slug. Unpublished markets are 404 for callers without read_drafts. */
export async function getMarketBySlug(
  slug: string,
  identity: RequestIdentity,
): Promise<MarketDetailDto | null> {
  const visibility = visibilityFor(identity, true);
  const asOf = new Date();
  return withActor(getDb(), identity.ctx, async (tx) => {
    const row = await resolveMarket(tx, slug, visibility);
    if (!row) return null;
    const ctx = await loadReadModelContext(tx, asOf);
    const [bundle] = await loadBundles(tx, [row], visibility);
    if (!bundle) return null;
    const extras = await loadDetailExtras(tx, row.market.id, visibility);
    const coordinateSource = await loadCoordinateSource(tx, row.market.coordinateSourceId);
    return toMarketDetail(bundle, extras, coordinateSource, ctx);
  });
}

async function loadCoordinateSource(tx: DbExecutor, id: string | null): Promise<SourceRow | null> {
  if (!id) return null;
  const rows = await tx.select().from(schema.sources).where(eq(schema.sources.id, id));
  return rows[0] ?? null;
}

const PUBLIC_VISIBILITY: Visibility = { readDrafts: false, includeUnpublished: false };

/** Loads published bundles with an anonymous context; the result is identity-independent. */
async function loadPublishedBundles(
  identity: RequestIdentity,
): Promise<{ bundles: MarketBundle[]; ctx: ReadModelContext }> {
  const asOf = new Date();
  return withActor(getDb(), identity.ctx, async (tx) => {
    const ctx = await loadReadModelContext(tx, asOf);
    const rows = await loadMarketRows(tx, [marketPublicationFilter(PUBLIC_VISIBILITY)]);
    const bundles = await loadBundles(tx, rows, PUBLIC_VISIBILITY);
    return { bundles, ctx };
  });
}

/** GET /api/v1/markets/geojson: published markets only, cached for a minute. */
export async function marketsGeoJson(identity: RequestIdentity): Promise<MarketGeoJson> {
  return cached('markets:geojson:v1', 60, async () => {
    const { bundles, ctx } = await loadPublishedBundles(identity);
    return {
      type: 'FeatureCollection' as const,
      features: bundles.map((bundle) => toGeoFeature(bundle, ctx)),
    };
  });
}

/** GET /api/v1/states: every state with the number of markets visible to the caller. */
export async function listStatesWithCounts(identity: RequestIdentity): Promise<StateWithCounts[]> {
  const visibility = visibilityFor(identity, true);
  return withActor(getDb(), identity.ctx, async (tx) => {
    const rows = await tx
      .select({
        id: schema.states.id,
        name: schema.states.name,
        geopoliticalZone: schema.states.geopoliticalZone,
        isFederalCapital: schema.states.isFederalCapital,
        marketCount: sql<number>`count(${schema.markets.id})::int`,
      })
      .from(schema.states)
      .leftJoin(
        schema.markets,
        and(eq(schema.markets.stateId, schema.states.id), marketPublicationFilter(visibility)),
      )
      .groupBy(schema.states.id)
      .orderBy(asc(schema.states.name));
    return rows.map((r) => ({ ...r, marketCount: Number(r.marketCount) }));
  });
}

interface ObservationCursor {
  scope: 'local' | 'regional';
  offset: number;
}

function encodeCursor(cursor: ObservationCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string | undefined): ObservationCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as Partial<ObservationCursor>;
    if (
      (parsed.scope === 'local' || parsed.scope === 'regional') &&
      typeof parsed.offset === 'number' &&
      Number.isInteger(parsed.offset) &&
      parsed.offset >= 0
    ) {
      return { scope: parsed.scope, offset: parsed.offset };
    }
  } catch {
    /* fall through */
  }
  throw new ApiError('validation_failed', 'cursor is not valid');
}

/**
 * GET /api/v1/markets/:idOrSlug/observations. Local rows come first (newest
 * observation date first), then statewide/national context, each labelled by
 * its badge; the cursor walks the two ordered lists in turn.
 */
export async function listMarketObservations(
  idOrSlug: string,
  query: MarketObservationsQuery,
  identity: RequestIdentity,
): Promise<MarketObservationsPage | null> {
  const visibility = visibilityFor(identity, true);
  const asOf = new Date();
  return withActor(getDb(), identity.ctx, async (tx) => {
    const row = await resolveMarket(tx, idOrSlug, visibility);
    if (!row) return null;
    const ctx = await loadReadModelContext(tx, asOf);
    const [bundle] = await loadBundles(tx, [row], visibility);
    if (!bundle) return null;
    const byDate = (a: ObservationDto, b: ObservationDto): number =>
      (b.observationPeriodEnd ?? b.sourceUpdatedAt ?? '').localeCompare(
        a.observationPeriodEnd ?? a.sourceUpdatedAt ?? '',
      ) || a.id.localeCompare(b.id);
    const local =
      query.scope === 'regional'
        ? []
        : bundle.local.map((r) => toObservationDto(r, ctx)).sort(byDate);
    const regional =
      query.scope === 'local'
        ? []
        : bundle.regional.map((r) => toObservationDto(r, ctx)).sort(byDate);
    const ordered = [...local, ...regional];
    const cursor = decodeCursor(query.cursor);
    const start = cursor ? (cursor.scope === 'local' ? 0 : local.length) + cursor.offset : 0;
    const items = ordered.slice(start, start + query.limit);
    const end = start + items.length;
    const nextCursor =
      end < ordered.length
        ? encodeCursor(
            end < local.length
              ? { scope: 'local', offset: end }
              : { scope: 'regional', offset: end - local.length },
          )
        : null;
    return {
      items,
      nextCursor,
      total: ordered.length,
      market: {
        id: row.market.id,
        slug: row.market.slug,
        name: row.market.name,
        stateName: row.state.name,
      },
    };
  });
}
