import 'server-only';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import {
  ApiError,
  type ComparisonReportDto,
  type ConsultationRequest,
  type ExplorerFilters,
  type Objective,
  type Priorities,
  type RankedMarketDto,
  type RecommendationRequest,
  type RecommendationResponse,
  type ScenarioAssumptions,
  type ScenarioCreate,
  type ScenarioDto,
  type ScenarioPage,
  type ScenarioShareResponse,
  type ScenarioSnapshotResponse,
  type ScenarioVerificationRequest,
  type ScenarioVerificationResponse,
  type SharedScenarioResponse,
  scenarioListQuerySchema,
  scenarioShareRequestSchema,
  scenarioUpdateSchema,
} from '@simplexd/contracts';
import {
  applyActorContext,
  getDb,
  schema,
  withActor,
  type ActorContext,
  type DbExecutor,
  type Transaction,
} from '@simplexd/db';
import { detectOverlap, METRIC_KEYS, type MarketInput } from '@simplexd/domain/ranking';
import { formatDate } from '@simplexd/domain/time';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { createLead } from '@/server/leads/create';
import { METRIC_LABELS } from './metric-map';
import { RECOMMENDATION_DISCLAIMER } from './ranking-adapter';
import { runRecommendationIn } from './recommendations';

/**
 * Saved scenarios: anonymous (owned by the sx_anon cookie token when the
 * `core.anonymous_scenarios` flag is on) or account-owned. Row-level security
 * decides visibility; this module only adds the business rules (limits,
 * optimistic concurrency, claiming, private sharing, snapshots and reports).
 *
 * Snapshots are append-only: a saved recommendation keeps the policy version,
 * exact inputs, source versions and results it was generated with, and is
 * never recomputed when policies or data change.
 */

export const ANONYMOUS_SCENARIO_LIMIT = 20;
export const ANONYMOUS_SCENARIOS_FLAG = 'core.anonymous_scenarios';

type ScenarioRow = typeof schema.scenarios.$inferSelect;
type SnapshotRow = typeof schema.recommendationSnapshots.$inferSelect;
export type ScenarioUpdate = z.infer<typeof scenarioUpdateSchema>;
export type ScenarioListQuery = z.infer<typeof scenarioListQuerySchema>;
export type ScenarioShareRequest = z.infer<typeof scenarioShareRequestSchema>;

interface StoredSnapshotResults {
  response: RecommendationResponse;
}

interface StoredSnapshotInputs {
  request: RecommendationRequest;
  marketInputs: MarketInput[];
  generatedFrom: { inputsHash: string; policyHash: string };
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

export function toScenarioDto(row: ScenarioRow): ScenarioDto {
  return {
    id: row.id,
    name: row.name,
    objective: row.objective as Objective,
    mode: row.mode,
    filters: row.filters as ExplorerFilters,
    assumptions: row.assumptions as ScenarioAssumptions,
    priorities: row.priorities as Priorities,
    marketIds: row.marketIds,
    policyVersion: row.policyVersion,
    ownerUserId: row.ownerUserId,
    organizationId: row.organizationId,
    isAnonymous: row.ownerUserId === null,
    shareToken: row.shareToken,
    shareExpiresAt: iso(row.shareExpiresAt),
    convertedServiceRequestId: row.convertedServiceRequestId,
    verificationRequestedAt: iso(row.verificationRequestedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Soft-deleted scenarios carry `expires_at` in the past; snapshots are append-only and retained. */
function alive(): SQL {
  return or(isNull(schema.scenarios.expiresAt), gt(schema.scenarios.expiresAt, sql`now()`)) as SQL;
}

async function loadScenario(tx: DbExecutor, id: string): Promise<ScenarioRow> {
  const rows = await tx
    .select()
    .from(schema.scenarios)
    .where(and(eq(schema.scenarios.id, id), alive()));
  const row = rows[0];
  if (!row) throw new ApiError('not_found', 'scenario not found or not accessible');
  return row;
}

/**
 * Audit and outbox tables are privileged-only. After the row-level-security
 * checked business write, the transaction is elevated just for the append,
 * then restored, so the append stays atomic with the change.
 */
async function withPrivilegedAppend<T>(
  tx: Transaction,
  ctx: ActorContext,
  fn: () => Promise<T>,
): Promise<T> {
  await applyActorContext(tx, { ...ctx, bypass: true });
  try {
    return await fn();
  } finally {
    await applyActorContext(tx, ctx);
  }
}

function requireUser(identity: RequestIdentity, message: string): string {
  const userId = identity.ctx.userId;
  if (!userId) throw new ApiError('unauthenticated', message);
  return userId;
}

function requireAnonymousToken(identity: RequestIdentity): string {
  if (!identity.featureFlags[ANONYMOUS_SCENARIOS_FLAG]) {
    throw new ApiError('unauthenticated', 'sign in to save a scenario');
  }
  const token = identity.ctx.anonymousToken;
  if (!token)
    throw new ApiError(
      'unauthenticated',
      'anonymous visitor cookie is missing; reload and try again',
    );
  return token;
}

async function assertMarketsExist(tx: DbExecutor, marketIds: readonly string[]): Promise<void> {
  if (marketIds.length === 0) return;
  const rows = await tx
    .select({ id: schema.markets.id })
    .from(schema.markets)
    .where(
      and(
        inArray(schema.markets.id, [...marketIds]),
        eq(schema.markets.publicationState, 'published'),
      ),
    );
  const found = new Set(rows.map((r) => r.id));
  const missing = marketIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new ApiError('validation_failed', 'some markets are unknown or not published', {
      details: { marketIds: missing },
    });
  }
}

async function assertAnonymousQuota(tx: DbExecutor, token: string): Promise<void> {
  const rows = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.scenarios)
    .where(
      and(
        eq(schema.scenarios.anonymousToken, token),
        isNull(schema.scenarios.ownerUserId),
        alive(),
      ),
    );
  if (Number(rows[0]?.n ?? 0) >= ANONYMOUS_SCENARIO_LIMIT) {
    throw new ApiError(
      'conflict',
      `You can keep up to ${ANONYMOUS_SCENARIO_LIMIT} scenarios before signing in; sign in to keep more.`,
    );
  }
}

/** POST /api/v1/scenarios */
export async function createScenario(
  input: ScenarioCreate,
  identity: RequestIdentity,
  correlationId: string,
): Promise<ScenarioDto> {
  const userId = identity.ctx.userId;
  const anonymousToken = userId ? null : requireAnonymousToken(identity);
  return withActor(getDb(), { ...identity.ctx, correlationId }, async (tx) => {
    await assertMarketsExist(tx, input.marketIds);
    if (anonymousToken) await assertAnonymousQuota(tx, anonymousToken);
    const [row] = await tx
      .insert(schema.scenarios)
      .values({
        ownerUserId: userId,
        organizationId: userId ? identity.ctx.organizationId : null,
        anonymousToken,
        name: input.name,
        objective: input.objective,
        mode: input.mode,
        filters: input.filters,
        assumptions: input.assumptions,
        priorities: input.priorities,
        marketIds: input.marketIds,
      })
      .returning();
    if (!row) throw new ApiError('internal_error', 'scenario was not created');
    await withPrivilegedAppend(tx, identity.ctx, () =>
      recordAudit(tx, identity, {
        action: 'scenario.created',
        entityType: 'scenario',
        entityId: row.id,
        after: { name: row.name, objective: row.objective, mode: row.mode, anonymous: !userId },
        correlationId,
      }),
    );
    return toScenarioDto(row);
  });
}

interface ListCursor {
  updatedAt: string;
  id: string;
}

function encodeCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string | undefined): ListCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as Partial<ListCursor>;
    if (
      typeof parsed.updatedAt === 'string' &&
      typeof parsed.id === 'string' &&
      !Number.isNaN(Date.parse(parsed.updatedAt))
    ) {
      return { updatedAt: parsed.updatedAt, id: parsed.id };
    }
  } catch {
    /* fall through */
  }
  throw new ApiError('validation_failed', 'cursor is not valid');
}

/** GET /api/v1/scenarios: the caller's own scenarios (account-owned or held by the anonymous token). */
export async function listScenarios(
  query: ScenarioListQuery,
  identity: RequestIdentity,
): Promise<ScenarioPage> {
  const userId = identity.ctx.userId;
  const token = identity.ctx.anonymousToken ?? null;
  const owners: SQL[] = [];
  if (userId) owners.push(eq(schema.scenarios.ownerUserId, userId));
  if (token) owners.push(eq(schema.scenarios.anonymousToken, token));
  if (owners.length === 0) return { items: [], nextCursor: null };
  const cursor = decodeCursor(query.cursor);
  const updatedMs = sql`date_trunc('milliseconds', ${schema.scenarios.updatedAt})`;
  const where: SQL[] = [or(...owners) as SQL, alive()];
  if (cursor) {
    where.push(
      sql`(${updatedMs}, ${schema.scenarios.id}) < (${cursor.updatedAt}::timestamptz, ${cursor.id}::uuid)`,
    );
  }
  const rows = await withActor(getDb(), identity.ctx, (tx) =>
    tx
      .select()
      .from(schema.scenarios)
      .where(and(...where))
      .orderBy(desc(updatedMs), desc(schema.scenarios.id))
      .limit(query.limit + 1),
  );
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toScenarioDto),
    nextCursor:
      rows.length > query.limit && last
        ? encodeCursor({ updatedAt: last.updatedAt.toISOString(), id: last.id })
        : null,
  };
}

/** GET /api/v1/scenarios/:id */
export async function getScenario(id: string, identity: RequestIdentity): Promise<ScenarioDto> {
  return withActor(getDb(), identity.ctx, async (tx) => toScenarioDto(await loadScenario(tx, id)));
}

/** PATCH /api/v1/scenarios/:id with optimistic concurrency on `expectedUpdatedAt`. */
export async function updateScenario(
  id: string,
  patch: ScenarioUpdate,
  identity: RequestIdentity,
  correlationId: string,
): Promise<ScenarioDto> {
  return withActor(getDb(), { ...identity.ctx, correlationId }, async (tx) => {
    const current = await loadScenario(tx, id);
    if (
      patch.expectedUpdatedAt !== undefined &&
      Date.parse(patch.expectedUpdatedAt) !== current.updatedAt.getTime()
    ) {
      throw new ApiError(
        'version_conflict',
        'the scenario changed since you loaded it; reload and retry',
        {
          details: { currentUpdatedAt: current.updatedAt.toISOString() },
        },
      );
    }
    if (patch.marketIds) await assertMarketsExist(tx, patch.marketIds);
    const { expectedUpdatedAt: _expected, ...changes } = patch;
    const values = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
    const [row] = await tx
      .update(schema.scenarios)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(schema.scenarios.id, id))
      .returning();
    if (!row) throw new ApiError('not_found', 'scenario not found or not accessible');
    return toScenarioDto(row);
  });
}

/** DELETE /api/v1/scenarios/:id: soft delete; snapshots and reports are append-only and stay. */
export async function deleteScenario(
  id: string,
  identity: RequestIdentity,
  correlationId: string,
): Promise<void> {
  await withActor(getDb(), { ...identity.ctx, correlationId }, async (tx) => {
    const current = await loadScenario(tx, id);
    await tx
      .update(schema.scenarios)
      .set({ expiresAt: new Date(), shareToken: null, shareExpiresAt: null })
      .where(eq(schema.scenarios.id, current.id));
    await withPrivilegedAppend(tx, identity.ctx, () =>
      recordAudit(tx, identity, {
        action: 'scenario.deleted',
        entityType: 'scenario',
        entityId: current.id,
        before: { name: current.name },
        correlationId,
      }),
    );
  });
}

/** POST /api/v1/scenarios/:id/claim: attach an anonymous scenario to the signed-in user (same cookie token). */
export async function claimScenario(
  id: string,
  identity: RequestIdentity,
  correlationId: string,
): Promise<ScenarioDto> {
  const userId = requireUser(identity, 'sign in to claim a scenario');
  const token = identity.ctx.anonymousToken;
  if (!token)
    throw new ApiError('forbidden', 'the anonymous scenario token is missing from this session');
  return withActor(getDb(), { ...identity.ctx, correlationId }, async (tx) => {
    const current = await loadScenario(tx, id);
    if (current.ownerUserId !== null) {
      if (current.ownerUserId === userId) return toScenarioDto(current);
      throw new ApiError('conflict', 'this scenario already belongs to an account');
    }
    if (current.anonymousToken !== token) {
      throw new ApiError('forbidden', 'this scenario was saved from a different browser session');
    }
    const [row] = await tx
      .update(schema.scenarios)
      .set({
        ownerUserId: userId,
        organizationId: identity.ctx.organizationId,
        anonymousToken: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.scenarios.id, current.id))
      .returning();
    if (!row) throw new ApiError('not_found', 'scenario not found or not accessible');
    await withPrivilegedAppend(tx, identity.ctx, () =>
      recordAudit(tx, identity, {
        action: 'scenario.claimed',
        entityType: 'scenario',
        entityId: row.id,
        before: { anonymous: true },
        after: { ownerUserId: userId, organizationId: identity.ctx.organizationId },
        correlationId,
      }),
    );
    return toScenarioDto(row);
  });
}

/** POST /api/v1/scenarios/:id/share: a private, expiring read-only link (account required). */
export async function shareScenario(
  id: string,
  body: ScenarioShareRequest,
  identity: RequestIdentity,
  correlationId: string,
): Promise<ScenarioShareResponse> {
  requireUser(identity, 'sign in to share a scenario privately');
  const shareToken = randomBytes(24).toString('base64url');
  const shareExpiresAt = new Date(Date.now() + body.expiresInDays * 86_400_000);
  return withActor(getDb(), { ...identity.ctx, correlationId }, async (tx) => {
    const current = await loadScenario(tx, id);
    await tx
      .update(schema.scenarios)
      .set({ shareToken, shareExpiresAt, updatedAt: new Date() })
      .where(eq(schema.scenarios.id, current.id));
    await withPrivilegedAppend(tx, identity.ctx, () =>
      recordAudit(tx, identity, {
        action: 'scenario.shared',
        entityType: 'scenario',
        entityId: current.id,
        after: { shareExpiresAt: shareExpiresAt.toISOString() },
        correlationId,
      }),
    );
    return {
      scenarioId: current.id,
      shareToken,
      shareExpiresAt: shareExpiresAt.toISOString(),
      sharePath: `/api/v1/scenarios/shared/${shareToken}`,
    };
  });
}

async function latestSnapshot(tx: DbExecutor, scenarioId: string): Promise<SnapshotRow | null> {
  const rows = await tx
    .select()
    .from(schema.recommendationSnapshots)
    .where(eq(schema.recommendationSnapshots.scenarioId, scenarioId))
    .orderBy(
      desc(schema.recommendationSnapshots.generatedAt),
      desc(schema.recommendationSnapshots.id),
    )
    .limit(1);
  return rows[0] ?? null;
}

function storedResponse(snapshot: SnapshotRow): RecommendationResponse {
  return (snapshot.results as StoredSnapshotResults).response;
}

/** GET /api/v1/scenarios/shared/:token: read-only view through the share token; owner fields are withheld. */
export async function getSharedScenario(token: string): Promise<SharedScenarioResponse> {
  const ctx: ActorContext = {
    userId: null,
    organizationId: null,
    staff: false,
    anonymousToken: token,
  };
  return withActor(getDb(), ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.scenarios)
      .where(
        and(
          eq(schema.scenarios.shareToken, token),
          gt(schema.scenarios.shareExpiresAt, sql`now()`),
          alive(),
        ),
      );
    const row = rows[0];
    if (!row) throw new ApiError('not_found', 'this share link is unknown or has expired');
    const snapshot = await latestSnapshot(tx, row.id);
    const dto = toScenarioDto(row);
    return {
      scenario: { ...dto, ownerUserId: null, organizationId: null, shareToken: null },
      snapshot: snapshot
        ? {
            id: snapshot.id,
            policyVersion: snapshot.policyVersion,
            generatedAt: snapshot.generatedAt.toISOString(),
            recommendation: storedResponse(snapshot),
          }
        : null,
      readOnly: true,
    };
  });
}

function requestFromScenario(scenario: ScenarioRow): RecommendationRequest {
  return {
    objective: scenario.objective as Objective,
    mode: scenario.mode,
    filters: scenario.filters as ExplorerFilters,
    priorities: scenario.priorities as Priorities,
    assumptions: scenario.assumptions as ScenarioAssumptions,
    marketIds: scenario.marketIds.length > 0 ? scenario.marketIds : undefined,
    rank: true,
    budgetCeiling: null,
    scenarioId: scenario.id,
  };
}

async function createSnapshotIn(
  tx: Transaction,
  scenario: ScenarioRow,
  identity: RequestIdentity,
  correlationId: string,
): Promise<ScenarioSnapshotResponse> {
  const asOf = new Date();
  const request = requestFromScenario(scenario);
  const run = await runRecommendationIn(tx, request, identity, asOf);
  const snapshotId = randomUUID();
  const recommendation: RecommendationResponse = { ...run.response, snapshotId };
  const inputs: StoredSnapshotInputs = {
    request,
    marketInputs: run.marketInputs,
    generatedFrom: {
      inputsHash: run.snapshot.generatedFrom.inputsHash,
      policyHash: run.snapshot.generatedFrom.policyHash,
    },
  };
  const [row] = await tx
    .insert(schema.recommendationSnapshots)
    .values({
      id: snapshotId,
      scenarioId: scenario.id,
      policyVersion: run.snapshot.policyVersion,
      inputs,
      sourceVersions: run.snapshot.generatedFrom.sourceVersions,
      results: { engine: run.result, response: recommendation },
      generatedBy: identity.ctx.userId,
      generatedAt: asOf,
    })
    .returning();
  if (!row) throw new ApiError('internal_error', 'snapshot was not stored');
  await tx
    .update(schema.scenarios)
    .set({ policyVersion: run.snapshot.policyVersion })
    .where(eq(schema.scenarios.id, scenario.id));
  await withPrivilegedAppend(tx, identity.ctx, () =>
    recordAudit(tx, identity, {
      action: 'scenario.snapshot_created',
      entityType: 'recommendation_snapshot',
      entityId: row.id,
      after: {
        scenarioId: scenario.id,
        policyVersion: row.policyVersion,
        inputsHash: inputs.generatedFrom.inputsHash,
      },
      correlationId,
    }),
  );
  return {
    snapshotId: row.id,
    scenarioId: scenario.id,
    policyVersion: row.policyVersion,
    generatedAt: row.generatedAt.toISOString(),
    inputsHash: inputs.generatedFrom.inputsHash,
    policyHash: inputs.generatedFrom.policyHash,
    sourceVersions: run.snapshot.generatedFrom.sourceVersions,
    recommendation,
  };
}

/** POST /api/v1/scenarios/:id/snapshot: runs the scenario's recommendation and stores it immutably. */
export async function snapshotScenario(
  id: string,
  identity: RequestIdentity,
  correlationId: string,
): Promise<ScenarioSnapshotResponse> {
  return withActor(getDb(), { ...identity.ctx, correlationId }, async (tx) => {
    const scenario = await loadScenario(tx, id);
    return createSnapshotIn(tx, scenario, identity, correlationId);
  });
}

type ReportRow = ComparisonReportDto['rows'][number];

function reportRows(markets: readonly RankedMarketDto[]): ReportRow[] {
  return METRIC_KEYS.map((metric) => ({
    metric,
    label: METRIC_LABELS[metric],
    cells: markets.map((market) => {
      const detail = market.metrics.find((m) => m.metric === metric);
      const badge = detail?.badge ?? 'unknown';
      return {
        marketId: market.marketId,
        value: detail?.value ?? null,
        unit: detail?.unit ?? null,
        badge,
        evidenceDate: detail?.evidenceDate ?? null,
        confidence: detail?.confidence ?? null,
        geographicScope: detail?.geographicScope ?? null,
        label:
          badge === 'user_assumption' || badge === 'model_estimate'
            ? 'your assumption'
            : (detail?.geographicScope ?? null),
      };
    }),
  }));
}

async function overlapWarningsFor(
  tx: DbExecutor,
  markets: readonly RankedMarketDto[],
): Promise<ComparisonReportDto['overlapWarnings']> {
  const ids = markets.map((m) => m.marketId);
  if (ids.length < 2) return [];
  const rows = await tx
    .select({
      id: schema.markets.id,
      name: schema.markets.name,
      parentMarketId: schema.markets.parentMarketId,
    })
    .from(schema.markets)
    .where(inArray(schema.markets.id, ids));
  const inputs: MarketInput[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    metrics: {},
    flags: { floodStatus: 'unknown', titleStatus: 'unknown' },
    hasLocalCostEvidence: false,
    hasLocalRentEvidence: false,
    parentMarketId: r.parentMarketId,
  }));
  const warning = detectOverlap(inputs);
  if (!warning) return [];
  const nameOf = (id: string): string => rows.find((r) => r.id === id)?.name ?? id;
  return warning.pairs.map(([a, b]) => ({
    marketIds: [a, b],
    message: `${nameOf(a)} and ${nameOf(b)} overlap geographically: overlapping populations, listings and demand totals must not be summed.`,
  }));
}

/**
 * GET /api/v1/scenarios/:id/report: a dated comparison report built from the
 * latest stored snapshot (one is created when none exists). The report never
 * recomputes: it reads what the snapshot stored, so older reports keep their
 * source snapshots when policies or data change later.
 */
export async function buildScenarioReport(
  id: string,
  identity: RequestIdentity,
  correlationId: string,
): Promise<ComparisonReportDto> {
  return withActor(getDb(), { ...identity.ctx, correlationId }, async (tx) => {
    const scenario = await loadScenario(tx, id);
    let snapshot = await latestSnapshot(tx, scenario.id);
    if (!snapshot) {
      await createSnapshotIn(tx, scenario, identity, correlationId);
      snapshot = await latestSnapshot(tx, scenario.id);
    }
    if (!snapshot) throw new ApiError('internal_error', 'snapshot was not stored');
    const response = storedResponse(snapshot);
    const inputs = snapshot.inputs as StoredSnapshotInputs;
    const all = [...response.organic, ...response.excluded];
    const selected =
      scenario.marketIds.length > 0
        ? scenario.marketIds
            .map((marketId) => all.find((m) => m.marketId === marketId))
            .filter((m): m is RankedMarketDto => m !== undefined)
        : response.organic;
    const generatedAt = new Date();
    const title = `${scenario.name}: comparison report (${formatDate(generatedAt)}, policy v${snapshot.policyVersion})`;
    const [report] = await tx
      .insert(schema.comparisonReports)
      .values({ scenarioId: scenario.id, snapshotId: snapshot.id, title, generatedAt })
      .returning();
    if (!report) throw new ApiError('internal_error', 'report was not stored');
    return {
      reportId: report.id,
      title,
      generatedAt: report.generatedAt.toISOString(),
      scenario: toScenarioDto(scenario),
      snapshot: {
        id: snapshot.id,
        policyVersion: snapshot.policyVersion,
        generatedAt: snapshot.generatedAt.toISOString(),
        inputsHash: inputs.generatedFrom.inputsHash,
        policyHash: inputs.generatedFrom.policyHash,
        sourceVersions: snapshot.sourceVersions as Record<string, string>,
      },
      markets: selected,
      rows: reportRows(selected),
      overlapWarnings: await overlapWarningsFor(tx, selected),
      disclaimer: RECOMMENDATION_DISCLAIMER,
    };
  });
}

export interface VerificationOptions {
  ipHash: string | null;
  userAgent: string | null;
  correlationId: string;
}

/**
 * POST /api/v1/scenarios/:id/request-verification: creates a `map_scenario`
 * lead carrying the scenario, its markets and budget, and marks the scenario.
 * Anonymous owners may request verification only while anonymous scenarios
 * are enabled; otherwise an account is required.
 */
export async function requestVerification(
  id: string,
  body: ScenarioVerificationRequest,
  identity: RequestIdentity,
  options: VerificationOptions,
): Promise<ScenarioVerificationResponse> {
  if (!identity.ctx.userId && !identity.featureFlags[ANONYMOUS_SCENARIOS_FLAG]) {
    throw new ApiError('unauthenticated', 'sign in to request local verification');
  }
  const scenario = await withActor(getDb(), identity.ctx, (tx) => loadScenario(tx, id));
  const filters = scenario.filters as ExplorerFilters;
  const lead: ConsultationRequest = {
    contactName: body.contactName,
    email: body.email,
    phoneE164: body.phoneE164 ?? null,
    countryOfResidence: body.countryOfResidence ?? null,
    timeZone: body.timeZone ?? null,
    goal: 'invest_and_compare',
    serviceSlug: null,
    message: body.message ?? null,
    scenarioId: scenario.id,
    marketIds: scenario.marketIds.slice(0, 10),
    budgetNaira: filters.totalBudgetNaira ?? null,
    marketingConsent: body.marketingConsent,
    consentPolicyVersion: body.consentPolicyVersion,
    ...(body.website !== undefined ? { website: body.website } : {}),
    ...(body.elapsedMs !== undefined ? { elapsedMs: body.elapsedMs } : {}),
  };
  const created = await createLead(lead, identity, { source: 'map_scenario', ...options });
  const requestedAt = new Date();
  await withActor(getDb(), { ...identity.ctx, correlationId: options.correlationId }, (tx) =>
    tx
      .update(schema.scenarios)
      .set({ verificationRequestedAt: requestedAt, updatedAt: requestedAt })
      .where(eq(schema.scenarios.id, scenario.id)),
  );
  return {
    scenarioId: scenario.id,
    leadId: created.id,
    leadStatus: created.status,
    verificationRequestedAt: requestedAt.toISOString(),
  };
}

export { scenarioListQuerySchema, scenarioShareRequestSchema, scenarioUpdateSchema };
