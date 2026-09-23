import { and, asc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { schema, type DbExecutor } from '@simplexd/db';
import type { Visibility } from './access';
import { CONTEXT_LEVELS, isLocalLevel } from './evidence';
import type {
  MarketBundle,
  MarketFlagRow,
  MarketRow,
  NeighborhoodRow,
  ObservationRecord,
  QuoteRow,
  ResearchTaskRow,
  ServiceCoverageRow,
  ServiceRow,
  StateRow,
  SupplierLeadRecord,
  TimelineTemplateRow,
} from './types';

/**
 * Database access for the market read model. Every function takes the
 * caller's transaction (already carrying the row-level security context) and
 * applies publication filters according to the caller's visibility.
 */

export interface MarketStateRow {
  market: MarketRow;
  state: StateRow;
}

/** Publication filter for markets: published only, or everything except archived for staff. */
export function marketPublicationFilter(visibility: Visibility): SQL {
  if (visibility.includeUnpublished) {
    return sql`${schema.markets.publicationState} <> 'archived'`;
  }
  return eq(schema.markets.publicationState, 'published');
}

export async function loadMarketRows(tx: DbExecutor, where: SQL[]): Promise<MarketStateRow[]> {
  return tx
    .select({ market: schema.markets, state: schema.states })
    .from(schema.markets)
    .innerJoin(schema.states, eq(schema.states.id, schema.markets.stateId))
    .where(and(...where))
    .orderBy(asc(schema.markets.displayOrder), asc(schema.markets.name));
}

async function loadObservations(
  tx: DbExecutor,
  marketIds: string[],
  stateIds: string[],
  visibility: Visibility,
): Promise<ObservationRecord[]> {
  const obs = schema.observations;
  const interp = schema.observationInterpretations;
  const scope: SQL[] = [eq(obs.geographyLevel, 'country')];
  if (marketIds.length > 0) {
    scope.push(inArray(obs.marketId, marketIds), inArray(interp.appliesToMarketId, marketIds));
  }
  if (stateIds.length > 0) scope.push(inArray(obs.stateId, stateIds));
  const conditions: SQL[] = [eq(interp.isCurrent, true), or(...scope) as SQL];
  if (!visibility.readDrafts) conditions.push(eq(interp.publicationState, 'published'));
  return tx
    .select({ observation: obs, interpretation: interp, source: schema.sources })
    .from(obs)
    .innerJoin(interp, eq(interp.observationId, obs.id))
    .innerJoin(schema.sources, eq(schema.sources.id, obs.sourceId))
    .where(and(...conditions))
    .orderBy(asc(obs.createdAt), asc(obs.id));
}

async function loadLeads(tx: DbExecutor, marketIds: string[]): Promise<SupplierLeadRecord[]> {
  if (marketIds.length === 0) return [];
  const rows = await tx
    .select({
      coverage: schema.supplierCoverage,
      facility: schema.supplyFacilities,
      state: schema.states,
      source: schema.sources,
    })
    .from(schema.supplierCoverage)
    .innerJoin(
      schema.supplyFacilities,
      eq(schema.supplyFacilities.id, schema.supplierCoverage.facilityId),
    )
    .leftJoin(schema.states, eq(schema.states.id, schema.supplyFacilities.stateId))
    .leftJoin(schema.sources, eq(schema.sources.id, schema.supplyFacilities.sourceId))
    .where(
      and(
        inArray(schema.supplierCoverage.marketId, marketIds),
        sql`${schema.supplyFacilities.archivedAt} IS NULL`,
      ),
    )
    .orderBy(asc(schema.supplyFacilities.name));
  return rows;
}

async function loadQuotes(
  tx: DbExecutor,
  marketIds: string[],
  visibility: Visibility,
): Promise<QuoteRow[]> {
  if (marketIds.length === 0) return [];
  const conditions: SQL[] = [inArray(schema.supplierQuotes.marketId, marketIds)];
  // Prices pending business review are never shown publicly.
  if (!visibility.readDrafts) conditions.push(eq(schema.supplierQuotes.reviewStatus, 'verified'));
  return tx
    .select()
    .from(schema.supplierQuotes)
    .where(and(...conditions))
    .orderBy(asc(schema.supplierQuotes.quotedAt));
}

async function loadTasks(tx: DbExecutor, marketIds: string[]): Promise<ResearchTaskRow[]> {
  if (marketIds.length === 0) return [];
  return tx
    .select()
    .from(schema.researchTasks)
    .where(inArray(schema.researchTasks.marketId, marketIds))
    .orderBy(asc(schema.researchTasks.priority), asc(schema.researchTasks.createdAt));
}

async function loadFlags(tx: DbExecutor, marketIds: string[]): Promise<MarketFlagRow[]> {
  if (marketIds.length === 0) return [];
  return tx
    .select()
    .from(schema.marketFlags)
    .where(
      and(inArray(schema.marketFlags.marketId, marketIds), eq(schema.marketFlags.active, true)),
    );
}

function groupBy<T>(items: readonly T[], key: (item: T) => string | null): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k === null) continue;
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

function localMarketId(record: ObservationRecord): string | null {
  if (!isLocalLevel(record.observation.geographyLevel)) return null;
  return record.interpretation.appliesToMarketId ?? record.observation.marketId;
}

/** Assembles bundles for the given market rows with the related evidence in a handful of queries. */
export async function loadBundles(
  tx: DbExecutor,
  rows: readonly MarketStateRow[],
  visibility: Visibility,
): Promise<MarketBundle[]> {
  const marketIds = rows.map((r) => r.market.id);
  const stateIds = [...new Set(rows.map((r) => r.market.stateId))];
  // Sequential on purpose: a transaction runs on one client, which queues concurrent queries.
  const observations = await loadObservations(tx, marketIds, stateIds, visibility);
  const leads = await loadLeads(tx, marketIds);
  const quotes = await loadQuotes(tx, marketIds, visibility);
  const tasks = await loadTasks(tx, marketIds);
  const flags = await loadFlags(tx, marketIds);
  const localByMarket = groupBy(observations, localMarketId);
  const regionalByState = groupBy(
    observations.filter((r) => r.observation.geographyLevel === 'state_or_fct'),
    (r) => r.observation.stateId,
  );
  const national = observations.filter((r) => r.observation.geographyLevel === 'country');
  const leadsByMarket = groupBy(leads, (l) => l.coverage.marketId);
  const quotesByMarket = groupBy(quotes, (q) => q.marketId);
  const tasksByMarket = groupBy(tasks, (t) => t.marketId);
  const flagsByMarket = groupBy(flags, (f) => f.marketId);

  return rows.map(({ market, state }) => ({
    market,
    state,
    local: localByMarket.get(market.id) ?? [],
    regional: [...(regionalByState.get(market.stateId) ?? []), ...national].filter((r) =>
      CONTEXT_LEVELS.has(r.observation.geographyLevel),
    ),
    leads: leadsByMarket.get(market.id) ?? [],
    quotes: quotesByMarket.get(market.id) ?? [],
    tasks: tasksByMarket.get(market.id) ?? [],
    flags: flagsByMarket.get(market.id) ?? [],
  }));
}

export interface MarketDetailExtras {
  neighborhoods: Array<NeighborhoodRow & { hasBoundary: boolean }>;
  serviceCoverage: Array<{ coverage: ServiceCoverageRow; service: ServiceRow }>;
  timelineTemplate: TimelineTemplateRow | null;
}

export async function loadDetailExtras(
  tx: DbExecutor,
  marketId: string,
  visibility: Visibility,
): Promise<MarketDetailExtras> {
  const neighborhoodConditions: SQL[] = [
    eq(schema.neighborhoods.marketId, marketId),
    sql`${schema.neighborhoods.archivedAt} IS NULL`,
  ];
  if (!visibility.readDrafts) {
    neighborhoodConditions.push(eq(schema.neighborhoods.publicationState, 'published'));
  }
  const neighborhoodRows = await tx
    .select({
      row: schema.neighborhoods,
      hasBoundary: sql<boolean>`${schema.neighborhoods.boundary} IS NOT NULL`,
    })
    .from(schema.neighborhoods)
    .where(and(...neighborhoodConditions))
    .orderBy(asc(schema.neighborhoods.name));
  const coverageRows = await tx
    .select({ coverage: schema.serviceCoverage, service: schema.services })
    .from(schema.serviceCoverage)
    .innerJoin(schema.services, eq(schema.services.id, schema.serviceCoverage.serviceId))
    .where(eq(schema.serviceCoverage.marketId, marketId))
    .orderBy(asc(schema.services.sortOrder));
  const templates = await tx
    .select()
    .from(schema.timelineTemplates)
    .where(eq(schema.timelineTemplates.kind, 'construction'))
    .orderBy(asc(schema.timelineTemplates.createdAt))
    .limit(1);
  return {
    neighborhoods: neighborhoodRows.map((r) => ({ ...r.row, hasBoundary: r.hasBoundary })),
    serviceCoverage: coverageRows,
    timelineTemplate: templates[0] ?? null,
  };
}
