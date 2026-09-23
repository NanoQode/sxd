import 'server-only';
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  ApiError,
  type AdminMarketListQuery,
  type AdminMarketRow,
  type MarketRevisionDto,
  type MarketUpsert,
} from '@simplexd/contracts';
import { appendOutbox, schema, type Transaction } from '@simplexd/db';
import { NIGERIA_BBOX } from '@simplexd/db/seed';
import { recordAudit } from '@/lib/audit';
import { cacheDelete } from '@/lib/cache';
import {
  actorId,
  assertVersion,
  authorize,
  changedFields,
  iso,
  notFound,
  transact,
  type AdminContext,
} from '../context';

type MarketRow = typeof schema.markets.$inferSelect;
type Snapshot = Record<string, unknown>;

/* ---------------------------------------------------------------------- */
/* Validation helpers                                                      */
/* ---------------------------------------------------------------------- */

export function assertInsideNigeria(location: { lon: number; lat: number }): void {
  const { lon, lat } = location;
  if (
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    lon < NIGERIA_BBOX.minLon ||
    lon > NIGERIA_BBOX.maxLon ||
    lat < NIGERIA_BBOX.minLat ||
    lat > NIGERIA_BBOX.maxLat
  ) {
    throw new ApiError(
      'validation_failed',
      `coordinates [${lon}, ${lat}] fall outside Nigeria (longitude ${NIGERIA_BBOX.minLon}–${NIGERIA_BBOX.maxLon}, latitude ${NIGERIA_BBOX.minLat}–${NIGERIA_BBOX.maxLat}; GeoJSON order is longitude, latitude)`,
      { details: [{ path: 'location', message: 'outside Nigeria bounding box' }] },
    );
  }
}

/** Editing a published market changes public data, so it needs the publisher permission. */
function editPermissionFor(row: Pick<MarketRow, 'publicationState'>) {
  return row.publicationState === 'published'
    ? ('market_data.publish' as const)
    : ('market_data.edit' as const);
}

async function loadMarket(tx: Transaction, id: string): Promise<MarketRow> {
  const rows = await tx.select().from(schema.markets).where(eq(schema.markets.id, id));
  const row = rows[0];
  if (!row) throw notFound('market');
  return row;
}

async function assertParentValid(
  tx: Transaction,
  id: string | null,
  parentMarketId: string | null | undefined,
): Promise<void> {
  if (!parentMarketId) return;
  if (id && parentMarketId === id)
    throw new ApiError('validation_failed', 'a market cannot be its own parent', {
      details: [{ path: 'parentMarketId', message: 'self reference' }],
    });
  let cursor: string | null = parentMarketId;
  for (let hops = 0; cursor && hops < 20; hops += 1) {
    const rows: Array<{ parentMarketId: string | null }> = await tx
      .select({ parentMarketId: schema.markets.parentMarketId })
      .from(schema.markets)
      .where(eq(schema.markets.id, cursor));
    const parent = rows[0];
    if (!parent) throw new ApiError('validation_failed', 'parent market not found');
    if (id && parent.parentMarketId === id)
      throw new ApiError('validation_failed', 'parent chain would form a cycle', {
        details: [{ path: 'parentMarketId', message: 'cycle' }],
      });
    cursor = parent.parentMarketId;
  }
}

async function assertSlugFree(tx: Transaction, slug: string, exceptId?: string): Promise<void> {
  const rows = await tx
    .select({ id: schema.markets.id })
    .from(schema.markets)
    .where(eq(schema.markets.slug, slug));
  if (rows.some((r) => r.id !== exceptId))
    throw new ApiError('conflict', `a market with slug "${slug}" already exists`, {
      details: [{ path: 'slug', message: 'already in use' }],
    });
}

/* ---------------------------------------------------------------------- */
/* Snapshots and revisions                                                 */
/* ---------------------------------------------------------------------- */

/** Fields captured in a revision snapshot and restored by rollback (content, not lifecycle). */
const CONTENT_FIELDS = [
  'slug',
  'name',
  'aliases',
  'stateId',
  'geopoliticalZone',
  'displayOrder',
  'selectionBasis',
  'location',
  'coordinateSourceId',
  'coordinateAccuracy',
  'sourceCityName',
  'parentMarketId',
  'overlapNote',
  'serviceAvailability',
  'profileMarkdown',
  'supplyMappingMethod',
  'recommendationStatus',
  'researchTasks',
  'lastResearchedAt',
] as const;

export function snapshotOf(row: MarketRow): Snapshot {
  const out: Snapshot = {};
  for (const key of CONTENT_FIELDS) out[key] = row[key] ?? null;
  out['publicationState'] = row.publicationState;
  out['mergedIntoMarketId'] = row.mergedIntoMarketId;
  out['archivedAt'] = iso(row.archivedAt);
  out['publishedAt'] = iso(row.publishedAt);
  out['humanEditedAt'] = iso(row.humanEditedAt);
  out['importedAt'] = iso(row.importedAt);
  return out;
}

/** Imported markets have no revision rows yet; capture the pre-edit state before the first change. */
async function ensureBaselineRevision(tx: Transaction, row: MarketRow): Promise<void> {
  const existing = await tx
    .select({ id: schema.marketRevisions.id })
    .from(schema.marketRevisions)
    .where(
      and(
        eq(schema.marketRevisions.marketId, row.id),
        eq(schema.marketRevisions.version, row.version),
      ),
    );
  if (existing.length > 0) return;
  await tx.insert(schema.marketRevisions).values({
    marketId: row.id,
    version: row.version,
    snapshot: snapshotOf(row),
    changeReason: row.importedAt ? 'Baseline captured from import before first edit' : 'Baseline',
    changedBy: row.updatedBy ?? null,
  });
}

async function insertRevision(
  tx: Transaction,
  row: MarketRow,
  changeReason: string,
  changedBy: string,
): Promise<void> {
  await tx.insert(schema.marketRevisions).values({
    marketId: row.id,
    version: row.version,
    snapshot: snapshotOf(row),
    changeReason,
    changedBy,
  });
}

async function publishedSideEffects(
  tx: Transaction,
  ctx: AdminContext,
  marketId: string,
  reason: string,
): Promise<void> {
  await appendOutbox(tx, {
    eventType: 'market_data.published',
    aggregateType: 'market',
    aggregateId: marketId,
    actorUserId: actorId(ctx),
    payload: { marketId, reason },
    correlationId: ctx.correlationId,
  });
}

/* ---------------------------------------------------------------------- */
/* Read models                                                             */
/* ---------------------------------------------------------------------- */

const localObservationsSql = sql<number>`(select count(*)::int from observations o where o.market_id = ${schema.markets.id})`;
const pendingReviewsSql = sql<number>`(select count(*)::int from observation_interpretations oi join observations o on o.id = oi.observation_id where coalesce(oi.applies_to_market_id, o.market_id) = ${schema.markets.id} and oi.is_current and oi.review_status = 'source_read_pending_business_review')`;
const openTasksSql = sql<number>`(select count(*)::int from research_tasks r where r.market_id = ${schema.markets.id} and r.status in ('open','in_progress','blocked'))`;

function rowSelection() {
  return {
    id: schema.markets.id,
    slug: schema.markets.slug,
    name: schema.markets.name,
    aliases: schema.markets.aliases,
    stateId: schema.markets.stateId,
    stateName: schema.states.name,
    geopoliticalZone: schema.markets.geopoliticalZone,
    displayOrder: schema.markets.displayOrder,
    location: schema.markets.location,
    parentMarketId: schema.markets.parentMarketId,
    serviceAvailability: schema.markets.serviceAvailability,
    publicationState: schema.markets.publicationState,
    recommendationStatus: schema.markets.recommendationStatus,
    localObservations: localObservationsSql,
    pendingReviews: pendingReviewsSql,
    openResearchTasks: openTasksSql,
    version: schema.markets.version,
    humanEditedAt: schema.markets.humanEditedAt,
    importedAt: schema.markets.importedAt,
    publishedAt: schema.markets.publishedAt,
    archivedAt: schema.markets.archivedAt,
    mergedIntoMarketId: schema.markets.mergedIntoMarketId,
    updatedAt: schema.markets.updatedAt,
  };
}

function toRow(r: Awaited<ReturnType<typeof selectRows>>[number]): AdminMarketRow {
  return {
    ...r,
    humanEditedAt: iso(r.humanEditedAt),
    importedAt: iso(r.importedAt),
    publishedAt: iso(r.publishedAt),
    archivedAt: iso(r.archivedAt),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function selectRows(tx: Transaction) {
  return tx
    .select(rowSelection())
    .from(schema.markets)
    .innerJoin(schema.states, eq(schema.states.id, schema.markets.stateId));
}

function whereFor(query: AdminMarketListQuery): SQL | undefined {
  const clauses: SQL[] = [];
  if (query.q) {
    const pattern = `%${query.q.replace(/[%_]/g, '')}%`;
    clauses.push(
      or(
        ilike(schema.markets.name, pattern),
        ilike(schema.markets.slug, pattern),
        sql`exists (select 1 from unnest(${schema.markets.aliases}) a where a ilike ${pattern})`,
      )!,
    );
  }
  if (query.stateId) clauses.push(eq(schema.markets.stateId, query.stateId));
  if (query.zone) clauses.push(eq(schema.markets.geopoliticalZone, query.zone));
  if (query.publicationState)
    clauses.push(eq(schema.markets.publicationState, query.publicationState));
  if (query.serviceAvailability)
    clauses.push(eq(schema.markets.serviceAvailability, query.serviceAvailability));
  if (query.recommendationStatus)
    clauses.push(eq(schema.markets.recommendationStatus, query.recommendationStatus));
  if (query.pendingReview) clauses.push(sql`${pendingReviewsSql} > 0`);
  return clauses.length > 0 ? and(...clauses) : undefined;
}

export async function listMarkets(
  ctx: AdminContext,
  query: AdminMarketListQuery,
): Promise<{ items: AdminMarketRow[]; total: number; page: number; pageSize: number }> {
  authorize(ctx, 'market_data.read_drafts');
  return transact(ctx, async (tx) => {
    const where = whereFor(query);
    const dir = query.order === 'desc' ? desc : asc;
    const orderBy =
      query.sort === 'state'
        ? [dir(schema.states.name), asc(schema.markets.name)]
        : query.sort === 'updatedAt'
          ? [dir(schema.markets.updatedAt)]
          : query.sort === 'displayOrder'
            ? [dir(schema.markets.displayOrder), asc(schema.markets.name)]
            : query.sort === 'publicationState'
              ? [dir(schema.markets.publicationState), asc(schema.markets.name)]
              : [dir(schema.markets.name)];
    const rows = await selectRows(tx)
      .where(where)
      .orderBy(...orderBy)
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);
    const totalRows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.markets)
      .innerJoin(schema.states, eq(schema.states.id, schema.markets.stateId))
      .where(where);
    return {
      items: rows.map(toRow),
      total: totalRows[0]?.n ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  });
}

export interface AdminMarketDetail extends AdminMarketRow {
  countryCode: string;
  selectionBasis: string | null;
  coordinateSourceId: string | null;
  coordinateSource: { id: string; slug: string; title: string } | null;
  coordinateAccuracy: string | null;
  sourceCityName: string | null;
  parent: { id: string; slug: string; name: string } | null;
  overlapNote: string | null;
  profileMarkdown: string | null;
  supplyMappingMethod: string | null;
  researchTaskTitles: string[];
  lastResearchedAt: string | null;
  lastReviewedAt: string | null;
  reviewedBy: string | null;
  publishedBy: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  regionalContextObservations: number;
  linkedProjects: number;
  linkedProperties: number;
  linkedServiceRequests: number;
  mergedInto: { id: string; slug: string; name: string } | null;
}

export async function getMarket(ctx: AdminContext, id: string): Promise<AdminMarketDetail> {
  authorize(ctx, 'market_data.read_drafts');
  return transact(ctx, async (tx) => {
    const rows = await selectRows(tx).where(eq(schema.markets.id, id));
    const base = rows[0];
    if (!base) throw notFound('market');
    const full = await loadMarket(tx, id);
    const [coordSource, parent, mergedInto, regional, projects, properties, requests] =
      await Promise.all([
        full.coordinateSourceId
          ? tx
              .select({
                id: schema.sources.id,
                slug: schema.sources.slug,
                title: schema.sources.title,
              })
              .from(schema.sources)
              .where(eq(schema.sources.id, full.coordinateSourceId))
          : Promise.resolve([]),
        full.parentMarketId
          ? tx
              .select({
                id: schema.markets.id,
                slug: schema.markets.slug,
                name: schema.markets.name,
              })
              .from(schema.markets)
              .where(eq(schema.markets.id, full.parentMarketId))
          : Promise.resolve([]),
        full.mergedIntoMarketId
          ? tx
              .select({
                id: schema.markets.id,
                slug: schema.markets.slug,
                name: schema.markets.name,
              })
              .from(schema.markets)
              .where(eq(schema.markets.id, full.mergedIntoMarketId))
          : Promise.resolve([]),
        tx
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.observations)
          .where(
            and(
              eq(schema.observations.stateId, full.stateId),
              eq(schema.observations.geographyLevel, 'state_or_fct'),
            ),
          ),
        tx
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.projects)
          .where(eq(schema.projects.marketId, id)),
        tx
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.properties)
          .where(eq(schema.properties.marketId, id)),
        tx
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.serviceRequests)
          .where(eq(schema.serviceRequests.marketId, id)),
      ]);
    return {
      ...toRow(base),
      countryCode: full.countryCode,
      selectionBasis: full.selectionBasis,
      coordinateSourceId: full.coordinateSourceId,
      coordinateSource: coordSource[0] ?? null,
      coordinateAccuracy: full.coordinateAccuracy,
      sourceCityName: full.sourceCityName,
      parent: parent[0] ?? null,
      overlapNote: full.overlapNote,
      profileMarkdown: full.profileMarkdown,
      supplyMappingMethod: full.supplyMappingMethod,
      researchTaskTitles: full.researchTasks ?? [],
      lastResearchedAt: full.lastResearchedAt,
      lastReviewedAt: iso(full.lastReviewedAt),
      reviewedBy: full.reviewedBy,
      publishedBy: full.publishedBy,
      createdBy: full.createdBy,
      updatedBy: full.updatedBy,
      createdAt: full.createdAt.toISOString(),
      regionalContextObservations: regional[0]?.n ?? 0,
      linkedProjects: projects[0]?.n ?? 0,
      linkedProperties: properties[0]?.n ?? 0,
      linkedServiceRequests: requests[0]?.n ?? 0,
      mergedInto: mergedInto[0] ?? null,
    };
  });
}

/* ---------------------------------------------------------------------- */
/* Create and edit                                                         */
/* ---------------------------------------------------------------------- */

export async function createMarket(ctx: AdminContext, input: MarketUpsert): Promise<MarketRow> {
  authorize(ctx, 'market_data.edit');
  assertInsideNigeria(input.location);
  const userId = actorId(ctx);
  return transact(ctx, async (tx) => {
    await assertSlugFree(tx, input.slug);
    const state = await tx
      .select({ id: schema.states.id, countryCode: schema.states.countryCode })
      .from(schema.states)
      .where(eq(schema.states.id, input.stateId));
    if (!state[0])
      throw new ApiError('validation_failed', 'state not found', {
        details: [{ path: 'stateId', message: 'unknown state' }],
      });
    await assertParentValid(tx, null, input.parentMarketId);
    const [row] = await tx
      .insert(schema.markets)
      .values({
        slug: input.slug,
        name: input.name,
        aliases: input.aliases,
        countryCode: state[0].countryCode,
        stateId: input.stateId,
        geopoliticalZone: input.geopoliticalZone,
        displayOrder: input.displayOrder,
        selectionBasis: input.selectionBasis ?? null,
        location: input.location,
        coordinateSourceId: input.coordinateSourceId ?? null,
        coordinateAccuracy: input.coordinateAccuracy ?? null,
        parentMarketId: input.parentMarketId ?? null,
        overlapNote: input.overlapNote ?? null,
        serviceAvailability: input.serviceAvailability,
        publicationState: 'draft',
        profileMarkdown: input.profileMarkdown ?? null,
        supplyMappingMethod: input.supplyMappingMethod ?? null,
        humanEditedAt: new Date(),
        createdBy: userId,
        updatedBy: userId,
      })
      .returning();
    await insertRevision(tx, row!, input.changeReason ?? 'Created', userId);
    await recordAudit(tx, ctx.identity, {
      action: 'market.created',
      entityType: 'market',
      entityId: row!.id,
      after: snapshotOf(row!),
      reason: input.changeReason ?? null,
      correlationId: ctx.correlationId,
    });
    return row!;
  });
}

export async function patchMarket(
  ctx: AdminContext,
  id: string,
  input: Partial<MarketUpsert> & { expectedVersion: number; changeReason: string },
): Promise<MarketRow> {
  const userId = actorId(ctx);
  const { row, published } = await transact(ctx, async (tx) => {
    const current = await loadMarket(tx, id);
    authorize(ctx, editPermissionFor(current), { type: 'market', id });
    assertVersion(current.version, input.expectedVersion);
    if (current.mergedIntoMarketId)
      throw new ApiError('invalid_transition', 'this market was merged; edit the target market');
    if (input.location) assertInsideNigeria(input.location);
    if (input.slug && input.slug !== current.slug) await assertSlugFree(tx, input.slug, id);
    if (input.parentMarketId !== undefined) await assertParentValid(tx, id, input.parentMarketId);
    let countryCode = current.countryCode;
    if (input.stateId && input.stateId !== current.stateId) {
      const state = await tx
        .select({ countryCode: schema.states.countryCode })
        .from(schema.states)
        .where(eq(schema.states.id, input.stateId));
      if (!state[0]) throw new ApiError('validation_failed', 'state not found');
      countryCode = state[0].countryCode;
    }
    await ensureBaselineRevision(tx, current);
    const { expectedVersion: _v, changeReason, ...fields } = input;
    const patch: Partial<MarketRow> = {};
    for (const key of CONTENT_FIELDS) {
      if (key in fields && fields[key as keyof typeof fields] !== undefined) {
        (patch as Record<string, unknown>)[key] = fields[key as keyof typeof fields];
      }
    }
    const [updated] = await tx
      .update(schema.markets)
      .set({
        ...patch,
        countryCode,
        version: current.version + 1,
        humanEditedAt: new Date(),
        updatedBy: userId,
      })
      .where(and(eq(schema.markets.id, id), eq(schema.markets.version, current.version)))
      .returning();
    if (!updated) throw new ApiError('version_conflict', 'the market changed concurrently');
    await insertRevision(tx, updated, changeReason, userId);
    const diff = changedFields(snapshotOf(current), snapshotOf(updated));
    await recordAudit(tx, ctx.identity, {
      action: 'market.updated',
      entityType: 'market',
      entityId: id,
      before: diff.before,
      after: diff.after,
      reason: changeReason,
      correlationId: ctx.correlationId,
    });
    const published = updated.publicationState === 'published';
    if (published) await publishedSideEffects(tx, ctx, id, changeReason);
    return { row: updated, published };
  });
  if (published) await cacheDelete('markets');
  return row;
}

export async function moveMarket(
  ctx: AdminContext,
  id: string,
  input: {
    location: { lon: number; lat: number };
    coordinateSourceId?: string | null;
    coordinateAccuracy?: string | null;
    expectedVersion: number;
    changeReason: string;
  },
): Promise<MarketRow> {
  return patchMarket(ctx, id, {
    location: input.location,
    ...(input.coordinateSourceId !== undefined
      ? { coordinateSourceId: input.coordinateSourceId }
      : {}),
    ...(input.coordinateAccuracy !== undefined
      ? { coordinateAccuracy: input.coordinateAccuracy }
      : {}),
    expectedVersion: input.expectedVersion,
    changeReason: input.changeReason,
  });
}

/* ---------------------------------------------------------------------- */
/* Lifecycle                                                               */
/* ---------------------------------------------------------------------- */

export type MarketLifecycleAction = 'publish' | 'unpublish' | 'archive' | 'restore';

function transitionFor(row: MarketRow, action: MarketLifecycleAction) {
  const s = row.publicationState;
  if (row.mergedIntoMarketId)
    return { ok: false as const, reason: 'merged into another market; only the target can change' };
  switch (action) {
    case 'publish':
      if (s === 'published') return { ok: false as const, reason: 'already published' };
      if (s === 'archived') return { ok: false as const, reason: 'archived; restore first' };
      return {
        ok: true as const,
        next: 'published' as const,
        permission: 'market_data.publish' as const,
      };
    case 'unpublish':
      if (s !== 'published') return { ok: false as const, reason: 'not published' };
      return {
        ok: true as const,
        next: 'unpublished' as const,
        permission: 'market_data.publish' as const,
      };
    case 'archive':
      if (s === 'archived') return { ok: false as const, reason: 'already archived' };
      return {
        ok: true as const,
        next: 'archived' as const,
        permission:
          s === 'published' ? ('market_data.publish' as const) : ('market_data.edit' as const),
      };
    case 'restore':
      if (s !== 'archived') return { ok: false as const, reason: 'not archived' };
      return { ok: true as const, next: 'draft' as const, permission: 'market_data.edit' as const };
  }
}

async function applyTransition(
  tx: Transaction,
  ctx: AdminContext,
  row: MarketRow,
  action: MarketLifecycleAction,
  reason: string,
): Promise<{ row: MarketRow; touchedPublic: boolean }> {
  const t = transitionFor(row, action);
  if (!t.ok) throw new ApiError('invalid_transition', `cannot ${action}: ${t.reason}`);
  authorize(ctx, t.permission, { type: 'market', id: row.id });
  const userId = actorId(ctx);
  const now = new Date();
  await ensureBaselineRevision(tx, row);
  const [updated] = await tx
    .update(schema.markets)
    .set({
      publicationState: t.next,
      version: row.version + 1,
      updatedBy: userId,
      ...(action === 'publish'
        ? { publishedAt: now, publishedBy: userId, lastReviewedAt: now, reviewedBy: userId }
        : {}),
      ...(action === 'archive' ? { archivedAt: now } : {}),
      ...(action === 'restore' ? { archivedAt: null } : {}),
    })
    .where(and(eq(schema.markets.id, row.id), eq(schema.markets.version, row.version)))
    .returning();
  if (!updated) throw new ApiError('version_conflict', 'the market changed concurrently');
  await insertRevision(tx, updated, `${action}: ${reason}`, userId);
  await recordAudit(tx, ctx.identity, {
    action: `market.${action === 'restore' ? 'restored' : `${action}${action.endsWith('e') ? 'd' : 'ed'}`}`,
    entityType: 'market',
    entityId: row.id,
    before: { publicationState: row.publicationState, version: row.version },
    after: { publicationState: updated.publicationState, version: updated.version },
    reason,
    correlationId: ctx.correlationId,
  });
  const touchedPublic =
    row.publicationState === 'published' || updated.publicationState === 'published';
  if (touchedPublic) await publishedSideEffects(tx, ctx, row.id, `${action}: ${reason}`);
  return { row: updated, touchedPublic };
}

export async function transitionMarket(
  ctx: AdminContext,
  id: string,
  action: MarketLifecycleAction,
  input: { expectedVersion: number; reason: string },
): Promise<MarketRow> {
  const result = await transact(ctx, async (tx) => {
    const current = await loadMarket(tx, id);
    assertVersion(current.version, input.expectedVersion);
    return applyTransition(tx, ctx, current, action, input.reason);
  });
  if (result.touchedPublic) await cacheDelete('markets');
  return result.row;
}

export interface BulkOutcome {
  id: string;
  slug: string;
  name: string;
  currentState: MarketRow['publicationState'];
  outcome: 'will_change' | 'changed' | 'skipped' | 'denied';
  detail: string;
}

export async function bulkMarkets(
  ctx: AdminContext,
  input: { action: 'publish' | 'unpublish'; marketIds: string[]; reason: string; preview: boolean },
): Promise<{ preview: boolean; outcomes: BulkOutcome[] }> {
  authorize(ctx, 'market_data.read_drafts');
  const outcomes: BulkOutcome[] = [];
  let touchedPublic = false;
  await transact(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.markets)
      .where(inArray(schema.markets.id, input.marketIds));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of input.marketIds) {
      const row = byId.get(id);
      if (!row) {
        outcomes.push({
          id,
          slug: '',
          name: '',
          currentState: 'draft',
          outcome: 'skipped',
          detail: 'not found',
        });
        continue;
      }
      const t = transitionFor(row, input.action);
      if (!t.ok) {
        outcomes.push({
          id,
          slug: row.slug,
          name: row.name,
          currentState: row.publicationState,
          outcome: 'skipped',
          detail: t.reason,
        });
        continue;
      }
      if (input.preview) {
        outcomes.push({
          id,
          slug: row.slug,
          name: row.name,
          currentState: row.publicationState,
          outcome: 'will_change',
          detail: `${row.publicationState} → ${t.next}`,
        });
        continue;
      }
      // An authorization failure aborts the whole batch: partial publication is worse than none.
      const result = await applyTransition(tx, ctx, row, input.action, input.reason);
      touchedPublic = touchedPublic || result.touchedPublic;
      outcomes.push({
        id,
        slug: row.slug,
        name: row.name,
        currentState: result.row.publicationState,
        outcome: 'changed',
        detail: `${row.publicationState} → ${result.row.publicationState}`,
      });
    }
  });
  if (touchedPublic) await cacheDelete('markets');
  return { preview: input.preview, outcomes };
}

/* ---------------------------------------------------------------------- */
/* Revisions and rollback                                                  */
/* ---------------------------------------------------------------------- */

export async function listRevisions(
  ctx: AdminContext,
  marketId: string,
): Promise<MarketRevisionDto[]> {
  authorize(ctx, 'market_data.history.read');
  return transact(ctx, async (tx) => {
    await loadMarket(tx, marketId);
    const rows = await tx
      .select({
        id: schema.marketRevisions.id,
        marketId: schema.marketRevisions.marketId,
        version: schema.marketRevisions.version,
        snapshot: schema.marketRevisions.snapshot,
        changeReason: schema.marketRevisions.changeReason,
        changedBy: schema.marketRevisions.changedBy,
        changedByName: schema.user.name,
        createdAt: schema.marketRevisions.createdAt,
      })
      .from(schema.marketRevisions)
      .leftJoin(schema.user, eq(schema.user.id, schema.marketRevisions.changedBy))
      .where(eq(schema.marketRevisions.marketId, marketId))
      .orderBy(desc(schema.marketRevisions.version));
    return rows.map((r) => ({
      ...r,
      snapshot: (r.snapshot ?? {}) as Snapshot,
      createdAt: r.createdAt.toISOString(),
    }));
  });
}

export interface RevisionDiffLine {
  field: string;
  left: unknown;
  right: unknown;
  changed: boolean;
}

export function diffSnapshots(left: Snapshot, right: Snapshot): RevisionDiffLine[] {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.map((field) => ({
    field,
    left: left[field] ?? null,
    right: right[field] ?? null,
    changed: JSON.stringify(left[field] ?? null) !== JSON.stringify(right[field] ?? null),
  }));
}

export async function compareRevisions(
  ctx: AdminContext,
  marketId: string,
  a: number,
  b: number,
): Promise<{ left: MarketRevisionDto; right: MarketRevisionDto; diff: RevisionDiffLine[] }> {
  const revisions = await listRevisions(ctx, marketId);
  const left = revisions.find((r) => r.version === a);
  const right = revisions.find((r) => r.version === b);
  if (!left || !right) throw notFound('revision');
  return { left, right, diff: diffSnapshots(left.snapshot, right.snapshot) };
}

/** Restores the content fields of an earlier revision as a new revision (history is never rewritten). */
export async function rollbackMarket(
  ctx: AdminContext,
  id: string,
  input: { revisionVersion: number; expectedVersion: number; reason: string },
): Promise<MarketRow> {
  const userId = actorId(ctx);
  const { row, published } = await transact(ctx, async (tx) => {
    const current = await loadMarket(tx, id);
    authorize(ctx, editPermissionFor(current), { type: 'market', id });
    assertVersion(current.version, input.expectedVersion);
    const target = await tx
      .select()
      .from(schema.marketRevisions)
      .where(
        and(
          eq(schema.marketRevisions.marketId, id),
          eq(schema.marketRevisions.version, input.revisionVersion),
        ),
      );
    const revision = target[0];
    if (!revision) throw notFound('revision');
    const snapshot = revision.snapshot as Snapshot;
    if (snapshot['location'])
      assertInsideNigeria(snapshot['location'] as { lon: number; lat: number });
    const slug = snapshot['slug'];
    if (typeof slug === 'string' && slug !== current.slug) await assertSlugFree(tx, slug, id);
    await ensureBaselineRevision(tx, current);
    const patch: Record<string, unknown> = {};
    for (const key of CONTENT_FIELDS) {
      if (key in snapshot) patch[key] = snapshot[key];
    }
    const [updated] = await tx
      .update(schema.markets)
      .set({
        ...(patch as Partial<MarketRow>),
        version: current.version + 1,
        humanEditedAt: new Date(),
        updatedBy: userId,
      })
      .where(and(eq(schema.markets.id, id), eq(schema.markets.version, current.version)))
      .returning();
    if (!updated) throw new ApiError('version_conflict', 'the market changed concurrently');
    const reason = `Rollback to revision ${input.revisionVersion}: ${input.reason}`;
    await insertRevision(tx, updated, reason, userId);
    const diff = changedFields(snapshotOf(current), snapshotOf(updated));
    await recordAudit(tx, ctx.identity, {
      action: 'market.rolled_back',
      entityType: 'market',
      entityId: id,
      before: { ...diff.before, version: current.version },
      after: { ...diff.after, version: updated.version, restoredRevision: input.revisionVersion },
      reason: input.reason,
      correlationId: ctx.correlationId,
    });
    const published = updated.publicationState === 'published';
    if (published) await publishedSideEffects(tx, ctx, id, reason);
    return { row: updated, published };
  });
  if (published) await cacheDelete('markets');
  return row;
}

/* ---------------------------------------------------------------------- */
/* Merge                                                                   */
/* ---------------------------------------------------------------------- */

export interface MergeResult {
  sourceId: string;
  targetId: string;
  repointed: Record<string, number>;
}

/**
 * Merges a duplicate market into a target. Immutable observations keep their
 * original market reference; their current interpretation gets a new version
 * that applies to the target. Operational records are repointed, the source
 * is archived with `mergedIntoMarketId`, and both markets gain a revision.
 */
export async function mergeMarket(
  ctx: AdminContext,
  sourceId: string,
  input: { targetMarketId: string; expectedVersion: number; reason: string },
): Promise<MergeResult> {
  const userId = actorId(ctx);
  const result = await transact(ctx, async (tx) => {
    if (sourceId === input.targetMarketId)
      throw new ApiError('validation_failed', 'a market cannot be merged into itself');
    const source = await loadMarket(tx, sourceId);
    const target = await loadMarket(tx, input.targetMarketId);
    assertVersion(source.version, input.expectedVersion);
    const permission =
      source.publicationState === 'published' || target.publicationState === 'published'
        ? 'market_data.publish'
        : 'market_data.edit';
    authorize(ctx, permission, { type: 'market', id: sourceId });
    if (source.mergedIntoMarketId)
      throw new ApiError('invalid_transition', 'this market was already merged');
    if (target.mergedIntoMarketId || target.publicationState === 'archived')
      throw new ApiError('invalid_transition', 'the target market is archived or merged');

    const repointed: Record<string, number> = {};
    const now = new Date();

    // Observation interpretations: new versions pointing at the target (history preserved).
    const interpretations = await tx
      .select({
        interpretation: schema.observationInterpretations,
        marketId: schema.observations.marketId,
      })
      .from(schema.observationInterpretations)
      .innerJoin(
        schema.observations,
        eq(schema.observations.id, schema.observationInterpretations.observationId),
      )
      .where(
        and(
          eq(schema.observationInterpretations.isCurrent, true),
          or(
            eq(schema.observationInterpretations.appliesToMarketId, sourceId),
            and(
              isNull(schema.observationInterpretations.appliesToMarketId),
              eq(schema.observations.marketId, sourceId),
            ),
          ),
        ),
      );
    for (const { interpretation } of interpretations) {
      await tx
        .update(schema.observationInterpretations)
        .set({ isCurrent: false })
        .where(eq(schema.observationInterpretations.id, interpretation.id));
      const { id: _id, version, createdAt: _c, ...rest } = interpretation;
      await tx.insert(schema.observationInterpretations).values({
        ...rest,
        version: version + 1,
        isCurrent: true,
        appliesToMarketId: input.targetMarketId,
        editorialNote: [rest.editorialNote, `Repointed from merged market ${source.slug}.`]
          .filter(Boolean)
          .join(' '),
        createdBy: userId,
      });
    }
    repointed['observationInterpretations'] = interpretations.length;

    // Supplier coverage: skip links the target already has.
    const coverage = await tx
      .select({ id: schema.supplierCoverage.id, facilityId: schema.supplierCoverage.facilityId })
      .from(schema.supplierCoverage)
      .where(eq(schema.supplierCoverage.marketId, sourceId));
    const targetCoverage = await tx
      .select({ facilityId: schema.supplierCoverage.facilityId })
      .from(schema.supplierCoverage)
      .where(eq(schema.supplierCoverage.marketId, input.targetMarketId));
    const have = new Set(targetCoverage.map((c) => c.facilityId));
    let moved = 0;
    for (const c of coverage) {
      if (have.has(c.facilityId)) continue;
      await tx
        .update(schema.supplierCoverage)
        .set({ marketId: input.targetMarketId })
        .where(eq(schema.supplierCoverage.id, c.id));
      moved += 1;
    }
    repointed['supplierCoverage'] = moved;
    repointed['supplierCoverageSkippedDuplicates'] = coverage.length - moved;

    const targetId = input.targetMarketId;
    repointed['supplierQuotes'] = (
      await tx
        .update(schema.supplierQuotes)
        .set({ marketId: targetId })
        .where(eq(schema.supplierQuotes.marketId, sourceId))
        .returning({ id: schema.supplierQuotes.id })
    ).length;
    repointed['researchTasks'] = (
      await tx
        .update(schema.researchTasks)
        .set({ marketId: targetId })
        .where(eq(schema.researchTasks.marketId, sourceId))
        .returning({ id: schema.researchTasks.id })
    ).length;
    repointed['properties'] = (
      await tx
        .update(schema.properties)
        .set({ marketId: targetId })
        .where(eq(schema.properties.marketId, sourceId))
        .returning({ id: schema.properties.id })
    ).length;
    repointed['projects'] = (
      await tx
        .update(schema.projects)
        .set({ marketId: targetId })
        .where(eq(schema.projects.marketId, sourceId))
        .returning({ id: schema.projects.id })
    ).length;
    repointed['serviceRequests'] = (
      await tx
        .update(schema.serviceRequests)
        .set({ marketId: targetId })
        .where(eq(schema.serviceRequests.marketId, sourceId))
        .returning({ id: schema.serviceRequests.id })
    ).length;
    repointed['marketFlags'] = (
      await tx
        .update(schema.marketFlags)
        .set({ marketId: targetId })
        .where(eq(schema.marketFlags.marketId, sourceId))
        .returning({ id: schema.marketFlags.id })
    ).length;
    repointed['estates'] = (
      await tx
        .update(schema.estates)
        .set({ marketId: targetId })
        .where(eq(schema.estates.marketId, sourceId))
        .returning({ id: schema.estates.id })
    ).length;
    repointed['approvalDurationObservations'] = (
      await tx
        .update(schema.approvalDurationObservations)
        .set({ marketId: targetId })
        .where(eq(schema.approvalDurationObservations.marketId, sourceId))
        .returning({ id: schema.approvalDurationObservations.id })
    ).length;

    // Neighborhoods keep their slug unless the target already uses it.
    const hoods = await tx
      .select({ id: schema.neighborhoods.id, slug: schema.neighborhoods.slug })
      .from(schema.neighborhoods)
      .where(eq(schema.neighborhoods.marketId, sourceId));
    const targetHoods = new Set(
      (
        await tx
          .select({ slug: schema.neighborhoods.slug })
          .from(schema.neighborhoods)
          .where(eq(schema.neighborhoods.marketId, input.targetMarketId))
      ).map((h) => h.slug),
    );
    for (const h of hoods) {
      const slug = targetHoods.has(h.slug) ? `${h.slug}-${source.slug}` : h.slug;
      await tx
        .update(schema.neighborhoods)
        .set({ marketId: input.targetMarketId, slug, updatedBy: userId })
        .where(eq(schema.neighborhoods.id, h.id));
      targetHoods.add(slug);
    }
    repointed['neighborhoods'] = hoods.length;

    await ensureBaselineRevision(tx, source);
    await ensureBaselineRevision(tx, target);
    const [sourceAfter] = await tx
      .update(schema.markets)
      .set({
        publicationState: 'archived',
        archivedAt: now,
        mergedIntoMarketId: input.targetMarketId,
        version: source.version + 1,
        updatedBy: userId,
      })
      .where(and(eq(schema.markets.id, sourceId), eq(schema.markets.version, source.version)))
      .returning();
    if (!sourceAfter) throw new ApiError('version_conflict', 'the market changed concurrently');
    const [targetAfter] = await tx
      .update(schema.markets)
      .set({
        aliases: [...new Set([...target.aliases, source.name, ...source.aliases])].filter(
          (a) => a.toLowerCase() !== target.name.toLowerCase(),
        ),
        version: target.version + 1,
        humanEditedAt: now,
        updatedBy: userId,
      })
      .where(
        and(
          eq(schema.markets.id, input.targetMarketId),
          eq(schema.markets.version, target.version),
        ),
      )
      .returning();
    if (!targetAfter)
      throw new ApiError('version_conflict', 'the target market changed concurrently');
    await insertRevision(tx, sourceAfter, `Merged into ${target.slug}: ${input.reason}`, userId);
    await insertRevision(tx, targetAfter, `Absorbed ${source.slug}: ${input.reason}`, userId);
    await recordAudit(tx, ctx.identity, {
      action: 'market.merged',
      entityType: 'market',
      entityId: sourceId,
      before: { publicationState: source.publicationState, mergedIntoMarketId: null },
      after: { publicationState: 'archived', mergedIntoMarketId: input.targetMarketId, repointed },
      reason: input.reason,
      correlationId: ctx.correlationId,
    });
    await recordAudit(tx, ctx.identity, {
      action: 'market.absorbed_merge',
      entityType: 'market',
      entityId: input.targetMarketId,
      before: { aliases: target.aliases, version: target.version },
      after: { aliases: targetAfter.aliases, version: targetAfter.version, mergedFrom: sourceId },
      reason: input.reason,
      correlationId: ctx.correlationId,
    });
    const touchedPublic =
      source.publicationState === 'published' || target.publicationState === 'published';
    if (touchedPublic) {
      await publishedSideEffects(tx, ctx, input.targetMarketId, `merge: ${input.reason}`);
    }
    return { sourceId, targetId: input.targetMarketId, repointed, touchedPublic };
  });
  if (result.touchedPublic) await cacheDelete('markets');
  return { sourceId: result.sourceId, targetId: result.targetId, repointed: result.repointed };
}

/* ---------------------------------------------------------------------- */
/* Reference lists for forms                                               */
/* ---------------------------------------------------------------------- */

export async function listStates(ctx: AdminContext) {
  authorize(ctx, 'market_data.read_drafts');
  return transact(ctx, (tx) =>
    tx
      .select({
        id: schema.states.id,
        name: schema.states.name,
        geopoliticalZone: schema.states.geopoliticalZone,
        isFederalCapital: schema.states.isFederalCapital,
      })
      .from(schema.states)
      .orderBy(asc(schema.states.name)),
  );
}

export async function listMarketOptions(ctx: AdminContext) {
  authorize(ctx, 'market_data.read_drafts');
  return transact(ctx, (tx) =>
    tx
      .select({
        id: schema.markets.id,
        slug: schema.markets.slug,
        name: schema.markets.name,
        publicationState: schema.markets.publicationState,
      })
      .from(schema.markets)
      .where(isNull(schema.markets.mergedIntoMarketId))
      .orderBy(asc(schema.markets.name)),
  );
}
