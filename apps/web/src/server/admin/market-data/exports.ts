import 'server-only';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { schema } from '@simplexd/db';
import { recordAudit } from '@/lib/audit';
import { authorize, iso, transact, type AdminContext } from '../context';

export interface ExportQuery {
  publicationState?: (typeof schema.publicationStateEnum.enumValues)[number];
  marketId?: string;
}

/** Markets with provenance: coordinate source, import fingerprint dates and review metadata. */
export async function exportMarkets(
  ctx: AdminContext,
  query: ExportQuery,
): Promise<Array<Record<string, unknown>>> {
  authorize(ctx, 'market_data.read_drafts');
  return transact(ctx, async (tx) => {
    const clauses: SQL[] = [];
    if (query.publicationState)
      clauses.push(eq(schema.markets.publicationState, query.publicationState));
    if (query.marketId) clauses.push(eq(schema.markets.id, query.marketId));
    const rows = await tx
      .select({
        m: schema.markets,
        stateName: schema.states.name,
        coordinateSourceSlug: schema.sources.slug,
        coordinateSourceTitle: schema.sources.title,
        coordinateSourceLicense: schema.sources.licenseNote,
      })
      .from(schema.markets)
      .innerJoin(schema.states, eq(schema.states.id, schema.markets.stateId))
      .leftJoin(schema.sources, eq(schema.sources.id, schema.markets.coordinateSourceId))
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      .orderBy(asc(schema.markets.displayOrder), asc(schema.markets.name));
    await recordAudit(tx, ctx.identity, {
      action: 'market_data.exported',
      entityType: 'market',
      entityId: null,
      after: { kind: 'markets', rows: rows.length, filters: query },
      correlationId: ctx.correlationId,
    });
    return rows.map(({ m, ...rest }) => ({
      id: m.id,
      slug: m.slug,
      name: m.name,
      aliases: m.aliases.join('|'),
      countryCode: m.countryCode,
      state: rest.stateName,
      geopoliticalZone: m.geopoliticalZone,
      displayOrder: m.displayOrder,
      longitude: m.location.lon,
      latitude: m.location.lat,
      coordinateAccuracy: m.coordinateAccuracy,
      coordinateSourceSlug: rest.coordinateSourceSlug,
      coordinateSourceTitle: rest.coordinateSourceTitle,
      coordinateSourceLicense: rest.coordinateSourceLicense,
      sourceCityName: m.sourceCityName,
      parentMarketId: m.parentMarketId,
      overlapNote: m.overlapNote,
      selectionBasis: m.selectionBasis,
      serviceAvailability: m.serviceAvailability,
      publicationState: m.publicationState,
      recommendationStatus: m.recommendationStatus,
      supplyMappingMethod: m.supplyMappingMethod,
      lastResearchedAt: m.lastResearchedAt,
      lastReviewedAt: iso(m.lastReviewedAt),
      publishedAt: iso(m.publishedAt),
      importedAt: iso(m.importedAt),
      importFingerprint: m.importFingerprint,
      humanEditedAt: iso(m.humanEditedAt),
      archivedAt: iso(m.archivedAt),
      mergedIntoMarketId: m.mergedIntoMarketId,
      version: m.version,
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
    }));
  });
}

/** Observations with their current interpretation and full source provenance. */
export async function exportObservations(
  ctx: AdminContext,
  query: ExportQuery,
): Promise<Array<Record<string, unknown>>> {
  authorize(ctx, 'market_data.read_drafts');
  return transact(ctx, async (tx) => {
    const effective = sql<
      string | null
    >`coalesce(${schema.observationInterpretations.appliesToMarketId}, ${schema.observations.marketId})`;
    const clauses: SQL[] = [eq(schema.observationInterpretations.isCurrent, true)];
    if (query.publicationState)
      clauses.push(eq(schema.observationInterpretations.publicationState, query.publicationState));
    if (query.marketId) clauses.push(sql`${effective} = ${query.marketId}`);
    const rows = await tx
      .select({
        o: schema.observations,
        i: schema.observationInterpretations,
        sourceSlug: schema.sources.slug,
        sourceTitle: schema.sources.title,
        sourceUrl: schema.sources.url,
        sourceLicenseNote: schema.sources.licenseNote,
        sourceLicenseRights: schema.sources.licenseRights,
        sourceRetrievedAt: schema.sources.retrievedAt,
        marketSlug: schema.markets.slug,
        marketName: schema.markets.name,
        stateName: schema.states.name,
      })
      .from(schema.observations)
      .innerJoin(
        schema.observationInterpretations,
        eq(schema.observationInterpretations.observationId, schema.observations.id),
      )
      .innerJoin(schema.sources, eq(schema.sources.id, schema.observations.sourceId))
      .leftJoin(schema.markets, eq(schema.markets.id, effective))
      .leftJoin(schema.states, eq(schema.states.id, schema.observations.stateId))
      .where(and(...clauses))
      .orderBy(asc(schema.observations.metric), asc(schema.observations.createdAt));
    await recordAudit(tx, ctx.identity, {
      action: 'market_data.exported',
      entityType: 'observation',
      entityId: null,
      after: { kind: 'observations', rows: rows.length, filters: query },
      correlationId: ctx.correlationId,
    });
    return rows.map(({ o, i, ...rest }) => ({
      id: o.id,
      slug: o.slug,
      metric: o.metric,
      value: o.valueNumeric,
      valueLow: o.valueLow,
      valueHigh: o.valueHigh,
      valueText: o.valueText,
      unit: o.unit,
      currency: o.currency,
      numericRepresentation: o.numericRepresentation,
      statistic: o.statistic,
      propertyCohort: o.propertyCohort,
      geographyLevel: o.geographyLevel,
      geographyLabel: o.geographyLabel,
      marketSlug: rest.marketSlug,
      marketName: rest.marketName,
      stateName: rest.stateName,
      neighborhoodId: o.neighborhoodId,
      observationPeriodStart: o.observationPeriodStart,
      observationPeriodEnd: o.observationPeriodEnd,
      periodCompleteAtRetrieval: o.periodCompleteAtRetrieval,
      sourceUpdatedAt: o.sourceUpdatedAt,
      retrievedAt: o.retrievedAt,
      validUntil: o.validUntil,
      sampleSize: o.sampleSize,
      collectionMethod: o.collectionMethod,
      licenseNote: o.licenseNote,
      sourceSlug: rest.sourceSlug,
      sourceTitle: rest.sourceTitle,
      sourceUrl: o.sourceUrl ?? rest.sourceUrl,
      sourceLicenseNote: rest.sourceLicenseNote,
      sourceLicenseRights: rest.sourceLicenseRights,
      sourceRetrievedAt: rest.sourceRetrievedAt,
      interpretationVersion: i.version,
      reviewStatus: i.reviewStatus,
      publicationState: i.publicationState,
      rankEligible: i.rankEligible,
      reasonNotRankEligible: i.reasonNotRankEligible,
      editorialNote: i.editorialNote,
      appliesToMarketId: i.appliesToMarketId,
      reviewerId: i.reviewerId,
      publishedAt: iso(i.publishedAt),
      createdBy: o.createdBy,
      createdAt: o.createdAt.toISOString(),
    }));
  });
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 CSV with a header row; column order follows the first row's keys. */
export function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '';
  const columns = Object.keys(rows[0]!);
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
