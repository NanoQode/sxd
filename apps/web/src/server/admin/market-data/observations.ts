import 'server-only';
import { and, asc, desc, eq, ilike, inArray, notInArray, or, sql, type SQL } from 'drizzle-orm';
import {
  ApiError,
  type ComparableSummary,
  type ObservationCreateInput,
  type ObservationListQuery,
  type ObservationReviewInput,
} from '@simplexd/contracts';
import { appendOutbox, schema, type Transaction } from '@simplexd/db';
import { recordAudit } from '@/lib/audit';
import { cacheDelete } from '@/lib/cache';
import {
  actorId,
  assertVersion,
  authorize,
  iso,
  notFound,
  transact,
  type AdminContext,
} from '../context';

type ObsRow = typeof schema.observations.$inferSelect;
type InterpRow = typeof schema.observationInterpretations.$inferSelect;

export interface InterpretationDto {
  id: string;
  version: number;
  isCurrent: boolean;
  reviewStatus: InterpRow['reviewStatus'];
  publicationState: InterpRow['publicationState'];
  rankEligible: boolean;
  reasonNotRankEligible: string | null;
  editorialNote: string | null;
  cohortMapping: string | null;
  appliesToMarketId: string | null;
  freshnessOverrideUntil: string | null;
  reviewerId: string | null;
  reviewerName: string | null;
  publishedBy: string | null;
  publishedAt: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface AdminObservationDto {
  id: string;
  slug: string | null;
  metric: string;
  value: number | null;
  valueLow: number | null;
  valueHigh: number | null;
  valueText: string | null;
  unit: string;
  currency: string | null;
  numericRepresentation: ObsRow['numericRepresentation'];
  statistic: ObsRow['statistic'];
  propertyCohort: string;
  geographyLevel: ObsRow['geographyLevel'];
  geographyLabel: string;
  stateId: string | null;
  stateName: string | null;
  marketId: string | null;
  effectiveMarketId: string | null;
  marketName: string | null;
  marketSlug: string | null;
  neighborhoodId: string | null;
  observationPeriodStart: string | null;
  observationPeriodEnd: string | null;
  periodCompleteAtRetrieval: boolean | null;
  sourceUpdatedAt: string | null;
  retrievedAt: string;
  sampleSize: number | null;
  collectionMethod: string | null;
  licenseNote: string | null;
  validUntil: string | null;
  evidenceFileId: string | null;
  source: {
    id: string;
    slug: string;
    title: string;
    url: string | null;
    licenseNote: string | null;
    licenseRights: string;
  };
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  interpretation: InterpretationDto;
}

export interface ReviewDto {
  id: string;
  interpretationId: string | null;
  reviewerId: string;
  reviewerName: string | null;
  decision: string;
  note: string | null;
  createdAt: string;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

function interpretationDto(
  i: InterpRow,
  names: Map<string, string>,
): InterpretationDto {
  return {
    id: i.id,
    version: i.version,
    isCurrent: i.isCurrent,
    reviewStatus: i.reviewStatus,
    publicationState: i.publicationState,
    rankEligible: i.rankEligible,
    reasonNotRankEligible: i.reasonNotRankEligible,
    editorialNote: i.editorialNote,
    cohortMapping: i.cohortMapping,
    appliesToMarketId: i.appliesToMarketId,
    freshnessOverrideUntil: i.freshnessOverrideUntil,
    reviewerId: i.reviewerId,
    reviewerName: i.reviewerId ? (names.get(i.reviewerId) ?? null) : null,
    publishedBy: i.publishedBy,
    publishedAt: iso(i.publishedAt),
    createdBy: i.createdBy,
    createdByName: i.createdBy ? (names.get(i.createdBy) ?? null) : null,
    createdAt: i.createdAt.toISOString(),
  };
}

const effectiveMarketSql = sql<string | null>`coalesce(${schema.observationInterpretations.appliesToMarketId}, ${schema.observations.marketId})`;

function baseSelect(tx: Transaction) {
  return tx
    .select({
      o: schema.observations,
      i: schema.observationInterpretations,
      source: {
        id: schema.sources.id,
        slug: schema.sources.slug,
        title: schema.sources.title,
        url: schema.sources.url,
        licenseNote: schema.sources.licenseNote,
        licenseRights: schema.sources.licenseRights,
      },
      marketName: schema.markets.name,
      marketSlug: schema.markets.slug,
      effectiveMarketId: effectiveMarketSql,
      stateName: schema.states.name,
    })
    .from(schema.observations)
    .innerJoin(
      schema.observationInterpretations,
      and(
        eq(schema.observationInterpretations.observationId, schema.observations.id),
        eq(schema.observationInterpretations.isCurrent, true),
      ),
    )
    .innerJoin(schema.sources, eq(schema.sources.id, schema.observations.sourceId))
    .leftJoin(schema.markets, eq(schema.markets.id, effectiveMarketSql))
    .leftJoin(schema.states, eq(schema.states.id, schema.observations.stateId));
}

type BaseRow = Awaited<ReturnType<ReturnType<typeof baseSelect>['execute']>>[number];

async function userNames(tx: Transaction, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (unique.length === 0) return new Map();
  const rows = await tx
    .select({ id: schema.user.id, name: schema.user.name })
    .from(schema.user)
    .where(inArray(schema.user.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

function toDto(r: BaseRow, names: Map<string, string>): AdminObservationDto {
  const o = r.o;
  return {
    id: o.id,
    slug: o.slug,
    metric: o.metric,
    value: num(o.valueNumeric),
    valueLow: num(o.valueLow),
    valueHigh: num(o.valueHigh),
    valueText: o.valueText,
    unit: o.unit,
    currency: o.currency,
    numericRepresentation: o.numericRepresentation,
    statistic: o.statistic,
    propertyCohort: o.propertyCohort,
    geographyLevel: o.geographyLevel,
    geographyLabel: o.geographyLabel,
    stateId: o.stateId,
    stateName: r.stateName,
    marketId: o.marketId,
    effectiveMarketId: r.effectiveMarketId,
    marketName: r.marketName,
    marketSlug: r.marketSlug,
    neighborhoodId: o.neighborhoodId,
    observationPeriodStart: o.observationPeriodStart,
    observationPeriodEnd: o.observationPeriodEnd,
    periodCompleteAtRetrieval: o.periodCompleteAtRetrieval,
    sourceUpdatedAt: o.sourceUpdatedAt,
    retrievedAt: o.retrievedAt,
    sampleSize: o.sampleSize,
    collectionMethod: o.collectionMethod,
    licenseNote: o.licenseNote,
    validUntil: o.validUntil,
    evidenceFileId: o.evidenceFileId,
    source: r.source,
    createdBy: o.createdBy,
    createdByName: o.createdBy ? (names.get(o.createdBy) ?? null) : null,
    createdAt: o.createdAt.toISOString(),
    interpretation: interpretationDto(r.i, names),
  };
}

async function toDtos(tx: Transaction, rows: BaseRow[]): Promise<AdminObservationDto[]> {
  const names = await userNames(
    tx,
    rows.flatMap((r) => [r.o.createdBy, r.i.createdBy, r.i.reviewerId, r.i.publishedBy]),
  );
  return rows.map((r) => toDto(r, names));
}

/* ---------------------------------------------------------------------- */
/* Lists                                                                   */
/* ---------------------------------------------------------------------- */

export async function listObservations(
  ctx: AdminContext,
  query: ObservationListQuery,
): Promise<{ items: AdminObservationDto[]; total: number; page: number; pageSize: number }> {
  authorize(ctx, 'market_data.read_drafts');
  return transact(ctx, async (tx) => {
    const clauses: SQL[] = [];
    if (query.pendingOnly)
      clauses.push(
        eq(schema.observationInterpretations.reviewStatus, 'source_read_pending_business_review'),
      );
    if (query.reviewStatus)
      clauses.push(eq(schema.observationInterpretations.reviewStatus, query.reviewStatus));
    if (query.publicationState)
      clauses.push(eq(schema.observationInterpretations.publicationState, query.publicationState));
    if (query.marketId) clauses.push(sql`${effectiveMarketSql} = ${query.marketId}`);
    if (query.stateId) clauses.push(eq(schema.observations.stateId, query.stateId));
    if (query.metric) clauses.push(eq(schema.observations.metric, query.metric));
    if (query.geographyLevel) clauses.push(eq(schema.observations.geographyLevel, query.geographyLevel));
    if (query.rankEligible !== undefined)
      clauses.push(eq(schema.observationInterpretations.rankEligible, query.rankEligible));
    if (query.q) {
      const pattern = `%${query.q.replace(/[%_]/g, '')}%`;
      clauses.push(
        or(
          ilike(schema.observations.metric, pattern),
          ilike(schema.observations.propertyCohort, pattern),
          ilike(schema.observations.geographyLabel, pattern),
          ilike(schema.sources.title, pattern),
          ilike(schema.markets.name, pattern),
        )!,
      );
    }
    const where = clauses.length > 0 ? and(...clauses) : undefined;
    const dir = query.order === 'desc' ? desc : asc;
    const orderBy =
      query.sort === 'retrievedAt'
        ? [dir(schema.observations.retrievedAt)]
        : query.sort === 'metric'
          ? [dir(schema.observations.metric), desc(schema.observations.createdAt)]
          : [dir(schema.observations.createdAt)];
    const rows = await baseSelect(tx)
      .where(where)
      .orderBy(...orderBy)
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);
    const total = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.observations)
      .innerJoin(
        schema.observationInterpretations,
        and(
          eq(schema.observationInterpretations.observationId, schema.observations.id),
          eq(schema.observationInterpretations.isCurrent, true),
        ),
      )
      .innerJoin(schema.sources, eq(schema.sources.id, schema.observations.sourceId))
      .leftJoin(schema.markets, eq(schema.markets.id, effectiveMarketSql))
      .where(where);
    return {
      items: await toDtos(tx, rows),
      total: total[0]?.n ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  });
}

/** Local observations plus statewide context for a market's Observations tab. */
export async function listObservationsForMarket(
  ctx: AdminContext,
  marketId: string,
): Promise<{ local: AdminObservationDto[]; statewide: AdminObservationDto[] }> {
  authorize(ctx, 'market_data.read_drafts');
  return transact(ctx, async (tx) => {
    const market = await tx
      .select({ stateId: schema.markets.stateId })
      .from(schema.markets)
      .where(eq(schema.markets.id, marketId));
    if (!market[0]) throw notFound('market');
    const local = await baseSelect(tx)
      .where(sql`${effectiveMarketSql} = ${marketId}`)
      .orderBy(desc(schema.observations.createdAt));
    const statewide = await baseSelect(tx)
      .where(
        and(
          eq(schema.observations.stateId, market[0].stateId),
          eq(schema.observations.geographyLevel, 'state_or_fct'),
        ),
      )
      .orderBy(desc(schema.observations.createdAt));
    return { local: await toDtos(tx, local), statewide: await toDtos(tx, statewide) };
  });
}

/* ---------------------------------------------------------------------- */
/* Comparables (publication policy)                                        */
/* ---------------------------------------------------------------------- */

async function minComparables(tx: Transaction): Promise<number> {
  const rows = await tx
    .select({ value: schema.dataPolicySettings.value })
    .from(schema.dataPolicySettings)
    .where(eq(schema.dataPolicySettings.key, 'publication.min_comparables'));
  const v = rows[0]?.value;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  const setting = await tx
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, 'publication.min_comparables'));
  const s = setting[0]?.value;
  return typeof s === 'number' && Number.isInteger(s) && s >= 0 ? s : 10;
}

const LOCAL_LEVELS = ['city', 'neighborhood', 'site'] as const;

/**
 * Counts deduplicated local comparables for the observation's market, metric
 * and cohort, and the share held by the largest source. Applies to medians at
 * city level or below; statewide context is never a local median.
 */
export async function comparableSummaryFor(
  tx: Transaction,
  obs: Pick<ObsRow, 'id' | 'marketId' | 'metric' | 'propertyCohort' | 'statistic' | 'geographyLevel'>,
  effectiveMarketId: string | null,
): Promise<ComparableSummary> {
  const min = await minComparables(tx);
  const marketId = effectiveMarketId ?? obs.marketId;
  const applicable =
    obs.statistic === 'median' &&
    (LOCAL_LEVELS as readonly string[]).includes(obs.geographyLevel) &&
    Boolean(marketId);
  if (!applicable || !marketId) {
    return {
      applicable: false,
      count: 0,
      minComparables: min,
      sourceConcentration: null,
      largestSourceTitle: null,
      satisfied: true,
    };
  }
  const rows = await tx
    .select({
      id: schema.observations.id,
      sourceId: schema.observations.sourceId,
      sourceTitle: schema.sources.title,
      valueNumeric: schema.observations.valueNumeric,
      periodEnd: schema.observations.observationPeriodEnd,
      sourceUrl: schema.observations.sourceUrl,
    })
    .from(schema.observations)
    .innerJoin(
      schema.observationInterpretations,
      and(
        eq(schema.observationInterpretations.observationId, schema.observations.id),
        eq(schema.observationInterpretations.isCurrent, true),
      ),
    )
    .innerJoin(schema.sources, eq(schema.sources.id, schema.observations.sourceId))
    .where(
      and(
        sql`${effectiveMarketSql} = ${marketId}`,
        eq(schema.observations.metric, obs.metric),
        eq(schema.observations.propertyCohort, obs.propertyCohort),
        inArray(schema.observations.geographyLevel, [...LOCAL_LEVELS]),
        notInArray(schema.observationInterpretations.reviewStatus, ['rejected', 'superseded']),
      ),
    );
  const seen = new Map<string, { sourceId: string; sourceTitle: string }>();
  for (const r of rows) {
    const key = `${r.sourceId}|${r.valueNumeric ?? ''}|${r.periodEnd ?? ''}|${r.sourceUrl ?? ''}`;
    if (!seen.has(key)) seen.set(key, { sourceId: r.sourceId, sourceTitle: r.sourceTitle });
  }
  const bySource = new Map<string, { title: string; n: number }>();
  for (const v of seen.values()) {
    const e = bySource.get(v.sourceId) ?? { title: v.sourceTitle, n: 0 };
    e.n += 1;
    bySource.set(v.sourceId, e);
  }
  const count = seen.size;
  let largest: { title: string; n: number } | null = null;
  for (const e of bySource.values()) if (!largest || e.n > largest.n) largest = e;
  return {
    applicable: true,
    count,
    minComparables: min,
    sourceConcentration: count > 0 && largest ? largest.n / count : null,
    largestSourceTitle: largest?.title ?? null,
    satisfied: count >= min,
  };
}

/* ---------------------------------------------------------------------- */
/* Detail                                                                  */
/* ---------------------------------------------------------------------- */

export interface AdminObservationDetail extends AdminObservationDto {
  history: InterpretationDto[];
  reviews: ReviewDto[];
  comparables: ComparableSummary;
}

export async function getObservation(ctx: AdminContext, id: string): Promise<AdminObservationDetail> {
  authorize(ctx, 'market_data.read_drafts');
  return transact(ctx, async (tx) => {
    const rows = await baseSelect(tx).where(eq(schema.observations.id, id));
    const row = rows[0];
    if (!row) throw notFound('observation');
    const history = await tx
      .select()
      .from(schema.observationInterpretations)
      .where(eq(schema.observationInterpretations.observationId, id))
      .orderBy(desc(schema.observationInterpretations.version));
    const reviews = await tx
      .select({
        id: schema.observationReviews.id,
        interpretationId: schema.observationReviews.interpretationId,
        reviewerId: schema.observationReviews.reviewerId,
        reviewerName: schema.user.name,
        decision: schema.observationReviews.decision,
        note: schema.observationReviews.note,
        createdAt: schema.observationReviews.createdAt,
      })
      .from(schema.observationReviews)
      .leftJoin(schema.user, eq(schema.user.id, schema.observationReviews.reviewerId))
      .where(eq(schema.observationReviews.observationId, id))
      .orderBy(desc(schema.observationReviews.createdAt));
    const names = await userNames(tx, [
      row.o.createdBy,
      ...history.flatMap((h) => [h.createdBy, h.reviewerId, h.publishedBy]),
    ]);
    const comparables = await comparableSummaryFor(tx, row.o, row.effectiveMarketId);
    return {
      ...toDto(row, names),
      history: history.map((h) => interpretationDto(h, names)),
      reviews: reviews.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
      comparables,
    };
  });
}

/* ---------------------------------------------------------------------- */
/* Create (immutable observation + interpretation v1 + review row)         */
/* ---------------------------------------------------------------------- */

function assertValueShape(input: ObservationCreateInput): void {
  const hasNumeric = input.value !== null && input.value !== undefined;
  const hasRange =
    input.valueLow !== null && input.valueLow !== undefined && input.valueHigh !== null && input.valueHigh !== undefined;
  const hasText = Boolean(input.valueText);
  const fail = (path: string, message: string) =>
    new ApiError('validation_failed', message, { details: [{ path, message }] });
  if (!hasNumeric && !hasRange && !hasText) throw fail('value', 'provide a value, a range or a categorical value');
  if (input.statistic === 'range' && !hasRange) throw fail('valueLow', 'a range needs valueLow and valueHigh');
  if (input.statistic === 'categorical' && !hasText) throw fail('valueText', 'a categorical observation needs valueText');
  if (hasRange && (input.valueLow as number) > (input.valueHigh as number)) throw fail('valueHigh', 'valueHigh must be >= valueLow');
  if (input.observationPeriodStart && input.observationPeriodEnd && input.observationPeriodStart > input.observationPeriodEnd)
    throw fail('observationPeriodEnd', 'period end must be on or after period start');
  const today = new Date().toISOString().slice(0, 10);
  if (input.retrievedAt > today) throw fail('retrievedAt', 'retrieval date cannot be in the future');
  if (input.numericRepresentation === 'kobo' && hasNumeric && !Number.isInteger(input.value))
    throw fail('value', 'kobo values must be integers');
}

export async function createObservation(
  ctx: AdminContext,
  input: ObservationCreateInput,
  options: { tx?: Transaction; auditReason?: string | null } = {},
): Promise<AdminObservationDto> {
  authorize(ctx, 'market_data.edit');
  assertValueShape(input);
  const userId = actorId(ctx);
  const run = async (tx: Transaction): Promise<AdminObservationDto> => {
    const source = await tx
      .select({ id: schema.sources.id })
      .from(schema.sources)
      .where(eq(schema.sources.id, input.sourceId));
    if (!source[0])
      throw new ApiError('validation_failed', 'source not found', {
        details: [{ path: 'sourceId', message: 'unknown source' }],
      });
    if (input.slug) {
      const dup = await tx
        .select({ id: schema.observations.id })
        .from(schema.observations)
        .where(eq(schema.observations.slug, input.slug));
      if (dup.length > 0) throw new ApiError('conflict', `observation slug "${input.slug}" already exists`);
    }
    let marketId = input.marketId ?? null;
    let stateId = input.stateId ?? null;
    const neighborhoodId = input.neighborhoodId ?? null;
    switch (input.geographyLevel) {
      case 'state_or_fct': {
        if (!stateId)
          throw new ApiError('validation_failed', 'statewide observations need stateId', {
            details: [{ path: 'stateId', message: 'required for state_or_fct' }],
          });
        marketId = null;
        break;
      }
      case 'city':
      case 'neighborhood':
      case 'site': {
        if (!marketId)
          throw new ApiError('validation_failed', `${input.geographyLevel} observations need marketId`, {
            details: [{ path: 'marketId', message: 'required' }],
          });
        if (input.geographyLevel === 'neighborhood' && !neighborhoodId)
          throw new ApiError('validation_failed', 'neighborhood observations need neighborhoodId', {
            details: [{ path: 'neighborhoodId', message: 'required' }],
          });
        break;
      }
      case 'country':
        marketId = null;
        stateId = null;
        break;
    }
    if (marketId) {
      const market = await tx
        .select({ id: schema.markets.id, mergedInto: schema.markets.mergedIntoMarketId })
        .from(schema.markets)
        .where(eq(schema.markets.id, marketId));
      if (!market[0]) throw new ApiError('validation_failed', 'market not found', { details: [{ path: 'marketId', message: 'unknown market' }] });
      if (market[0].mergedInto) throw new ApiError('validation_failed', 'market was merged; record against the target market');
    }
    if (stateId) {
      const state = await tx.select({ id: schema.states.id }).from(schema.states).where(eq(schema.states.id, stateId));
      if (!state[0]) throw new ApiError('validation_failed', 'state not found', { details: [{ path: 'stateId', message: 'unknown state' }] });
    }
    if (neighborhoodId) {
      const hood = await tx
        .select({ id: schema.neighborhoods.id, marketId: schema.neighborhoods.marketId })
        .from(schema.neighborhoods)
        .where(eq(schema.neighborhoods.id, neighborhoodId));
      if (!hood[0] || hood[0].marketId !== marketId)
        throw new ApiError('validation_failed', 'neighborhood does not belong to the market', { details: [{ path: 'neighborhoodId', message: 'mismatch' }] });
    }
    const [obs] = await tx
      .insert(schema.observations)
      .values({
        slug: input.slug ?? null,
        sourceId: input.sourceId,
        sourceUrl: input.sourceUrl ?? null,
        metric: input.metric,
        valueNumeric: input.value === null || input.value === undefined ? null : String(input.value),
        valueLow: input.valueLow === null || input.valueLow === undefined ? null : String(input.valueLow),
        valueHigh: input.valueHigh === null || input.valueHigh === undefined ? null : String(input.valueHigh),
        valueText: input.valueText ?? null,
        unit: input.unit,
        currency: input.currency ?? null,
        numericRepresentation: input.numericRepresentation,
        geographyLevel: input.geographyLevel,
        geographyLabel: input.geographyLabel,
        stateId,
        marketId,
        neighborhoodId,
        propertyCohort: input.propertyCohort,
        statistic: input.statistic,
        observationPeriodStart: input.observationPeriodStart ?? null,
        observationPeriodEnd: input.observationPeriodEnd ?? null,
        periodCompleteAtRetrieval: input.periodCompleteAtRetrieval ?? null,
        sourceUpdatedAt: input.sourceUpdatedAt ?? null,
        retrievedAt: input.retrievedAt,
        sampleSize: input.sampleSize ?? null,
        collectionMethod: input.collectionMethod ?? null,
        licenseNote: input.licenseNote ?? null,
        validUntil: input.validUntil ?? null,
        rankEligible: false,
        reasonNotRankEligible: 'Awaiting business review',
        evidenceFileId: input.evidenceFileId ?? null,
        createdBy: userId,
      })
      .returning();
    const [interp] = await tx
      .insert(schema.observationInterpretations)
      .values({
        observationId: obs!.id,
        version: 1,
        isCurrent: true,
        reviewStatus: 'source_read_pending_business_review',
        publicationState: 'draft',
        rankEligible: false,
        reasonNotRankEligible: 'Awaiting business review',
        editorialNote:
          input.editorialNote ??
          (input.geographyLevel === 'state_or_fct' ? 'Statewide context; not a city value.' : null),
        cohortMapping: input.propertyCohort,
        appliesToMarketId: marketId,
        createdBy: userId,
      })
      .returning();
    await tx.insert(schema.observationReviews).values({
      observationId: obs!.id,
      interpretationId: interp!.id,
      reviewerId: userId,
      decision: 'submitted',
      note: options.auditReason ?? 'Submitted for business review',
    });
    await recordAudit(tx, ctx.identity, {
      action: 'observation.created',
      entityType: 'observation',
      entityId: obs!.id,
      after: { metric: obs!.metric, statistic: obs!.statistic, geographyLevel: obs!.geographyLevel, marketId, stateId, sourceId: obs!.sourceId, interpretationVersion: 1 },
      reason: options.auditReason ?? null,
      correlationId: ctx.correlationId,
    });
    const rows = await baseSelect(tx).where(eq(schema.observations.id, obs!.id));
    const dtos = await toDtos(tx, rows);
    return dtos[0]!;
  };
  return options.tx ? run(options.tx) : transact(ctx, run);
}

/* ---------------------------------------------------------------------- */
/* Review decisions                                                        */
/* ---------------------------------------------------------------------- */

export interface ReviewResult {
  observation: AdminObservationDetail;
  invalidatedPublicData: boolean;
}

/**
 * Applies a review decision by closing the current interpretation and
 * inserting the next version. Publishing and rank eligibility need the
 * approver permission on a submission by someone else (own_work is denied by
 * the authorization policy); publication of local medians is gated by the
 * configured number of deduplicated comparables.
 */
export async function reviewObservation(
  ctx: AdminContext,
  observationId: string,
  input: ObservationReviewInput,
): Promise<ReviewResult> {
  const userId = actorId(ctx);
  const invalidated = await transact(ctx, async (tx) => {
    const rows = await baseSelect(tx).where(eq(schema.observations.id, observationId));
    const row = rows[0];
    if (!row) throw notFound('observation');
    const obs = row.o;
    const current = row.i;
    assertVersion(current.version, input.expectedVersion);

    const owned = { type: 'observation_interpretation', id: current.id, createdBy: current.createdBy ?? obs.createdBy };
    const unowned = { type: 'observation_interpretation', id: current.id };
    const fail = (message: string) => new ApiError('invalid_transition', message);
    const note = input.note?.trim() || null;

    const next: Partial<InterpRow> = {};
    switch (input.decision) {
      case 'approve': {
        authorize(ctx, 'market_data.publish', owned);
        if (current.reviewStatus === 'rejected') throw fail('a rejected observation cannot be approved; submit a new observation');
        next.reviewStatus = 'verified';
        next.reviewerId = userId;
        break;
      }
      case 'reject': {
        authorize(ctx, 'market_data.publish', unowned);
        if (!note) throw new ApiError('validation_failed', 'a rejection needs a note explaining why');
        next.reviewStatus = 'rejected';
        next.reviewerId = userId;
        next.rankEligible = false;
        next.reasonNotRankEligible = `Rejected: ${note}`;
        if (current.publicationState === 'published') next.publicationState = 'unpublished';
        break;
      }
      case 'dispute': {
        authorize(ctx, 'market_data.edit', unowned);
        if (!note) throw new ApiError('validation_failed', 'a dispute needs a note describing the challenge');
        next.reviewStatus = 'disputed';
        next.rankEligible = false;
        next.reasonNotRankEligible = `Disputed: ${note}`;
        break;
      }
      case 'mark_stale': {
        authorize(ctx, 'market_data.edit', unowned);
        next.reviewStatus = 'stale';
        next.rankEligible = false;
        next.reasonNotRankEligible = note ? `Stale: ${note}` : 'Marked stale by review';
        break;
      }
      case 'publish': {
        authorize(ctx, 'market_data.publish', owned);
        if (current.publicationState === 'published') throw fail('already published');
        if (!['source_read_pending_business_review', 'verified'].includes(current.reviewStatus))
          throw fail(`cannot publish an observation whose review status is ${current.reviewStatus}`);
        const comparables = await comparableSummaryFor(tx, obs, row.effectiveMarketId);
        if (comparables.applicable && !comparables.satisfied) {
          if (!input.publishAsContextual) {
            throw new ApiError(
              'insufficient_evidence',
              `local medians need at least ${comparables.minComparables} deduplicated comparables before publication; ${comparables.count} found. Publish as contextual evidence instead, or collect more comparables.`,
              { details: comparables },
            );
          }
          next.rankEligible = false;
          next.reasonNotRankEligible = `Published as contextual evidence, not a local median: ${comparables.count} of ${comparables.minComparables} deduplicated comparables${comparables.largestSourceTitle ? ` (largest source ${comparables.largestSourceTitle}, ${Math.round((comparables.sourceConcentration ?? 0) * 100)}% concentration)` : ''}.${note ? ` ${note}` : ''}`;
        }
        next.reviewStatus = 'verified';
        next.publicationState = 'published';
        next.publishedBy = userId;
        next.publishedAt = new Date();
        next.reviewerId = userId;
        break;
      }
      case 'unpublish': {
        authorize(ctx, 'market_data.publish', unowned);
        if (current.publicationState !== 'published') throw fail('not published');
        if (!note) throw new ApiError('validation_failed', 'unpublishing needs a reason');
        next.publicationState = 'unpublished';
        next.rankEligible = false;
        next.reasonNotRankEligible = `Unpublished: ${note}`;
        break;
      }
      case 'mark_rank_eligible': {
        authorize(ctx, 'market_data.publish', owned);
        if (!note) throw new ApiError('validation_failed', 'rank eligibility needs a reason');
        if (current.publicationState !== 'published' || current.reviewStatus !== 'verified')
          throw fail('only published, verified observations can become rank-eligible');
        if (!(LOCAL_LEVELS as readonly string[]).includes(obs.geographyLevel))
          throw fail('statewide or national context is never rank-eligible');
        const comparables = await comparableSummaryFor(tx, obs, row.effectiveMarketId);
        if (comparables.applicable && !comparables.satisfied)
          throw new ApiError(
            'insufficient_evidence',
            `a local median needs at least ${comparables.minComparables} deduplicated comparables to be rank-eligible; ${comparables.count} found`,
            { details: comparables },
          );
        next.rankEligible = true;
        next.reasonNotRankEligible = null;
        next.editorialNote = [current.editorialNote, `Rank-eligible: ${note}`].filter(Boolean).join(' ');
        break;
      }
      case 'mark_rank_ineligible': {
        authorize(ctx, 'market_data.edit', unowned);
        const reason = input.reasonNotRankEligible?.trim() || note;
        if (!reason) throw new ApiError('validation_failed', 'reasonNotRankEligible is required');
        next.rankEligible = false;
        next.reasonNotRankEligible = reason;
        break;
      }
    }

    await tx
      .update(schema.observationInterpretations)
      .set({ isCurrent: false })
      .where(eq(schema.observationInterpretations.id, current.id));
    const { id: _id, version, createdAt: _createdAt, ...carry } = current;
    const [created] = await tx
      .insert(schema.observationInterpretations)
      .values({ ...carry, ...next, version: version + 1, isCurrent: true, createdBy: userId })
      .returning();
    await tx.insert(schema.observationReviews).values({
      observationId,
      interpretationId: created!.id,
      reviewerId: userId,
      decision: input.decision,
      note,
    });
    const before = { version: current.version, reviewStatus: current.reviewStatus, publicationState: current.publicationState, rankEligible: current.rankEligible, reasonNotRankEligible: current.reasonNotRankEligible };
    const after = { version: created!.version, reviewStatus: created!.reviewStatus, publicationState: created!.publicationState, rankEligible: created!.rankEligible, reasonNotRankEligible: created!.reasonNotRankEligible };
    await recordAudit(tx, ctx.identity, {
      action: `observation.${input.decision}`,
      entityType: 'observation',
      entityId: observationId,
      before,
      after,
      reason: note,
      correlationId: ctx.correlationId,
    });
    const publicChanged =
      current.publicationState === 'published' ||
      created!.publicationState === 'published' ||
      current.rankEligible !== created!.rankEligible;
    if (publicChanged) {
      await appendOutbox(tx, {
        eventType: 'market_data.published',
        aggregateType: 'observation',
        aggregateId: observationId,
        actorUserId: userId,
        payload: {
          observationId,
          marketId: row.effectiveMarketId,
          decision: input.decision,
          publicationState: created!.publicationState,
          rankEligible: created!.rankEligible,
        },
        correlationId: ctx.correlationId,
      });
    }
    return publicChanged;
  });
  if (invalidated) await cacheDelete('markets');
  const observation = await getObservation(ctx, observationId);
  return { observation, invalidatedPublicData: invalidated };
}

/** Distinct metrics in use, for filters. */
export async function listObservationMetrics(ctx: AdminContext): Promise<string[]> {
  authorize(ctx, 'market_data.read_drafts');
  return transact(ctx, async (tx) => {
    const rows = await tx
      .selectDistinct({ metric: schema.observations.metric })
      .from(schema.observations)
      .orderBy(asc(schema.observations.metric));
    return rows.map((r) => r.metric);
  });
}
