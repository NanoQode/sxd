import 'server-only';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { ApiError, type RankingPolicyDto } from '@simplexd/contracts';
import { appendOutbox, schema } from '@simplexd/db';
import {
  validateRankingPolicy,
  type ConfidenceRubric,
  type MetricBound,
  type MetricKey,
  type PolicyError,
  type RankingPolicy,
} from '@simplexd/domain/ranking';
import { recordAudit } from '@/lib/audit';
import { cacheDelete } from '@/lib/cache';
import {
  actorId,
  assertUpdatedAt,
  authorize,
  changedFields,
  iso,
  notFound,
  transact,
  type AdminContext,
} from '../context';

type PolicyRow = typeof schema.rankingPolicies.$inferSelect;

/* ---------------------------------------------------------------------- */
/* Ranking policies                                                        */
/* ---------------------------------------------------------------------- */

export function toRankingPolicy(row: PolicyRow): RankingPolicy {
  return {
    version: row.version,
    weights: (row.weights ?? {}) as Record<MetricKey, number>,
    metricBounds: (row.metricBounds ?? []) as unknown as MetricBound[],
    confidenceRubric: row.confidenceRubric as ConfidenceRubric,
    coverageThreshold: Number(row.coverageThreshold),
    minComparables: row.minComparables,
  };
}

export function policyErrors(row: PolicyRow): PolicyError[] {
  return validateRankingPolicy(toRankingPolicy(row));
}

function toDto(row: PolicyRow): RankingPolicyDto {
  return {
    id: row.id,
    version: row.version,
    name: row.name,
    status: row.status,
    weights: row.weights ?? {},
    metricBounds: (row.metricBounds ?? []) as RankingPolicyDto['metricBounds'],
    confidenceRubric: row.confidenceRubric,
    coverageThreshold: Number(row.coverageThreshold),
    minComparables: row.minComparables,
    hardConstraints: row.hardConstraints ?? null,
    notes: row.notes,
    createdBy: row.createdBy,
    approvedBy: row.approvedBy,
    activatedAt: iso(row.activatedAt),
    retiredAt: iso(row.retiredAt),
    createdAt: row.createdAt.toISOString(),
    errors: policyErrors(row),
  };
}

export async function listRankingPolicies(ctx: AdminContext): Promise<RankingPolicyDto[]> {
  authorize(ctx, 'market_data.read_drafts');
  return transact(ctx, async (tx) => {
    const rows = await tx.select().from(schema.rankingPolicies).orderBy(desc(schema.rankingPolicies.version));
    return rows.map(toDto);
  });
}

export async function getRankingPolicy(ctx: AdminContext, version: number): Promise<RankingPolicyDto> {
  authorize(ctx, 'market_data.read_drafts');
  return transact(ctx, async (tx) => {
    const rows = await tx.select().from(schema.rankingPolicies).where(eq(schema.rankingPolicies.version, version));
    if (!rows[0]) throw notFound('ranking policy');
    return toDto(rows[0]);
  });
}

export async function createRankingPolicyDraft(
  ctx: AdminContext,
  input: { name: string; fromVersion?: number; notes?: string | null },
): Promise<RankingPolicyDto> {
  authorize(ctx, 'market_data.policy.manage');
  const userId = actorId(ctx);
  return transact(ctx, async (tx) => {
    const base = input.fromVersion
      ? await tx.select().from(schema.rankingPolicies).where(eq(schema.rankingPolicies.version, input.fromVersion))
      : await tx.select().from(schema.rankingPolicies).where(eq(schema.rankingPolicies.status, 'active'));
    const from = base[0];
    if (!from) throw new ApiError('not_found', 'no policy to copy from (no active policy)');
    const maxRows = await tx.select({ max: sql<number>`coalesce(max(version), 0)::int` }).from(schema.rankingPolicies);
    const version = (maxRows[0]?.max ?? 0) + 1;
    const [row] = await tx
      .insert(schema.rankingPolicies)
      .values({
        version,
        name: input.name,
        status: 'draft',
        weights: from.weights,
        metricBounds: from.metricBounds,
        confidenceRubric: from.confidenceRubric,
        coverageThreshold: from.coverageThreshold,
        minComparables: from.minComparables,
        hardConstraints: from.hardConstraints,
        notes: input.notes ?? `Draft copied from version ${from.version}.`,
        createdBy: userId,
      })
      .returning();
    await recordAudit(tx, ctx.identity, {
      action: 'ranking_policy.draft_created',
      entityType: 'ranking_policy',
      entityId: row!.id,
      after: { version, name: input.name, copiedFrom: from.version },
      correlationId: ctx.correlationId,
    });
    return toDto(row!);
  });
}

export interface RankingPolicyPatch {
  name?: string;
  weights?: Record<string, number>;
  metricBounds?: Array<Record<string, unknown>>;
  confidenceRubric?: Record<string, unknown>;
  coverageThreshold?: number;
  minComparables?: number;
  hardConstraints?: Record<string, unknown> | null;
  notes?: string | null;
  reason?: string;
}

/** Drafts save even with policy errors so work is not lost; the errors are returned and block activation. */
export async function patchRankingPolicyDraft(
  ctx: AdminContext,
  version: number,
  input: RankingPolicyPatch,
): Promise<RankingPolicyDto> {
  authorize(ctx, 'market_data.policy.manage');
  return transact(ctx, async (tx) => {
    const rows = await tx.select().from(schema.rankingPolicies).where(eq(schema.rankingPolicies.version, version));
    const current = rows[0];
    if (!current) throw notFound('ranking policy');
    if (current.status !== 'draft')
      throw new ApiError('invalid_transition', `policy version ${version} is ${current.status}; create a new draft to change it`);
    const [updated] = await tx
      .update(schema.rankingPolicies)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.weights !== undefined ? { weights: input.weights } : {}),
        ...(input.metricBounds !== undefined ? { metricBounds: input.metricBounds as unknown as PolicyRow['metricBounds'] } : {}),
        ...(input.confidenceRubric !== undefined ? { confidenceRubric: input.confidenceRubric } : {}),
        ...(input.coverageThreshold !== undefined ? { coverageThreshold: String(input.coverageThreshold) } : {}),
        ...(input.minComparables !== undefined ? { minComparables: input.minComparables } : {}),
        ...(input.hardConstraints !== undefined ? { hardConstraints: input.hardConstraints } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      })
      .where(eq(schema.rankingPolicies.id, current.id))
      .returning();
    const diff = changedFields(toDto(current) as unknown as Record<string, unknown>, toDto(updated!) as unknown as Record<string, unknown>);
    await recordAudit(tx, ctx.identity, {
      action: 'ranking_policy.draft_updated',
      entityType: 'ranking_policy',
      entityId: current.id,
      before: diff.before,
      after: diff.after,
      reason: input.reason ?? null,
      correlationId: ctx.correlationId,
    });
    return toDto(updated!);
  });
}

/** Activation validates the policy; equal or invalid bounds and missing weights are rejected. */
export async function activateRankingPolicy(
  ctx: AdminContext,
  version: number,
  input: { reason: string },
): Promise<RankingPolicyDto> {
  authorize(ctx, 'market_data.policy.manage');
  const userId = actorId(ctx);
  const dto = await transact(ctx, async (tx) => {
    const rows = await tx.select().from(schema.rankingPolicies).where(eq(schema.rankingPolicies.version, version));
    const draft = rows[0];
    if (!draft) throw notFound('ranking policy');
    if (draft.status !== 'draft') throw new ApiError('invalid_transition', `policy version ${version} is ${draft.status}`);
    const errors = policyErrors(draft);
    if (errors.length > 0)
      throw new ApiError('validation_failed', 'the policy has configuration errors and cannot be activated', {
        details: errors,
      });
    const now = new Date();
    const retired = await tx
      .update(schema.rankingPolicies)
      .set({ status: 'retired', retiredAt: now })
      .where(eq(schema.rankingPolicies.status, 'active'))
      .returning({ id: schema.rankingPolicies.id, version: schema.rankingPolicies.version });
    const [activated] = await tx
      .update(schema.rankingPolicies)
      .set({ status: 'active', activatedAt: now, approvedBy: userId })
      .where(and(eq(schema.rankingPolicies.id, draft.id), eq(schema.rankingPolicies.status, 'draft')))
      .returning();
    if (!activated) throw new ApiError('version_conflict', 'the policy changed concurrently');
    await recordAudit(tx, ctx.identity, {
      action: 'ranking_policy.activated',
      entityType: 'ranking_policy',
      entityId: activated.id,
      before: { activeVersions: retired.map((r) => r.version) },
      after: { activeVersion: version, weights: activated.weights, coverageThreshold: Number(activated.coverageThreshold), minComparables: activated.minComparables },
      reason: input.reason,
      correlationId: ctx.correlationId,
    });
    for (const r of retired) {
      await recordAudit(tx, ctx.identity, {
        action: 'ranking_policy.retired',
        entityType: 'ranking_policy',
        entityId: r.id,
        before: { status: 'active' },
        after: { status: 'retired', replacedBy: version },
        reason: input.reason,
        correlationId: ctx.correlationId,
      });
    }
    await appendOutbox(tx, {
      eventType: 'market_data.published',
      aggregateType: 'ranking_policy',
      aggregateId: activated.id,
      actorUserId: userId,
      payload: { policyVersion: version, reason: input.reason },
      correlationId: ctx.correlationId,
    });
    return toDto(activated);
  });
  await cacheDelete('markets');
  return dto;
}

/* ---------------------------------------------------------------------- */
/* Freshness policies                                                      */
/* ---------------------------------------------------------------------- */

export interface FreshnessPolicyDto {
  id: string;
  dataType: string;
  maxAgeDays: number | null;
  respectSourceValidity: boolean;
  note: string | null;
  updatedBy: string | null;
  updatedAt: string;
}

const freshnessDto = (r: typeof schema.freshnessPolicies.$inferSelect): FreshnessPolicyDto => ({
  id: r.id,
  dataType: r.dataType,
  maxAgeDays: r.maxAgeDays,
  respectSourceValidity: r.respectSourceValidity,
  note: r.note,
  updatedBy: r.updatedBy,
  updatedAt: r.updatedAt.toISOString(),
});

export async function listFreshnessPolicies(ctx: AdminContext): Promise<FreshnessPolicyDto[]> {
  authorize(ctx, 'market_data.read_drafts');
  return transact(ctx, async (tx) => {
    const rows = await tx.select().from(schema.freshnessPolicies).orderBy(asc(schema.freshnessPolicies.dataType));
    return rows.map(freshnessDto);
  });
}

export async function upsertFreshnessPolicy(
  ctx: AdminContext,
  dataType: string,
  input: { maxAgeDays: number | null; respectSourceValidity: boolean; note?: string | null; reason: string; expectedUpdatedAt?: string },
): Promise<FreshnessPolicyDto> {
  authorize(ctx, 'market_data.policy.manage');
  if (!/^[a-z][a-z0-9_]{1,60}$/.test(dataType))
    throw new ApiError('validation_failed', 'dataType must be a snake_case identifier');
  const userId = actorId(ctx);
  const dto = await transact(ctx, async (tx) => {
    const existing = await tx.select().from(schema.freshnessPolicies).where(eq(schema.freshnessPolicies.dataType, dataType));
    const current = existing[0];
    if (current) assertUpdatedAt(current.updatedAt, input.expectedUpdatedAt);
    const [row] = await tx
      .insert(schema.freshnessPolicies)
      .values({
        dataType,
        maxAgeDays: input.maxAgeDays,
        respectSourceValidity: input.respectSourceValidity,
        note: input.note ?? null,
        updatedBy: userId,
      })
      .onConflictDoUpdate({
        target: schema.freshnessPolicies.dataType,
        set: {
          maxAgeDays: input.maxAgeDays,
          respectSourceValidity: input.respectSourceValidity,
          note: input.note ?? null,
          updatedBy: userId,
          updatedAt: new Date(),
        },
      })
      .returning();
    await recordAudit(tx, ctx.identity, {
      action: current ? 'freshness_policy.updated' : 'freshness_policy.created',
      entityType: 'freshness_policy',
      entityId: row!.id,
      before: current ? { maxAgeDays: current.maxAgeDays, respectSourceValidity: current.respectSourceValidity, note: current.note } : null,
      after: { maxAgeDays: row!.maxAgeDays, respectSourceValidity: row!.respectSourceValidity, note: row!.note },
      reason: input.reason,
      correlationId: ctx.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'market_data.published',
      aggregateType: 'freshness_policy',
      aggregateId: row!.id,
      actorUserId: userId,
      payload: { dataType, reason: input.reason },
      correlationId: ctx.correlationId,
    });
    return freshnessDto(row!);
  });
  await cacheDelete('markets');
  return dto;
}

/* ---------------------------------------------------------------------- */
/* Data policy settings                                                    */
/* ---------------------------------------------------------------------- */

export interface DataPolicyDto {
  key: string;
  value: unknown;
  description: string | null;
  updatedBy: string | null;
  updatedAt: string;
}

const DATA_POLICY_VALIDATORS: Record<string, (v: unknown) => string | null> = {
  'publication.min_comparables': (v) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 1000 ? null : 'must be an integer between 1 and 1000',
  'ranking.coverage_threshold': (v) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? null : 'must be a number between 0 and 1',
  'ranking.require_local_cost_and_rent': (v) => (typeof v === 'boolean' ? null : 'must be true or false'),
  default_financial_ranking_enabled: (v) => (typeof v === 'boolean' ? null : 'must be true or false'),
};

export const DATA_POLICY_DESCRIPTIONS: Record<string, string> = {
  'publication.min_comparables': 'Deduplicated comparables required before a local median is published (publication policy, not a statistical guarantee).',
  'ranking.coverage_threshold': 'Minimum weighted coverage for an investment ranking.',
  'ranking.require_local_cost_and_rent': 'Investment ranking requires locally applicable cost AND rental inputs.',
  default_financial_ranking_enabled: 'Whether financial ranking may run in default (evidence) mode.',
};

export async function listDataPolicies(ctx: AdminContext): Promise<DataPolicyDto[]> {
  authorize(ctx, 'market_data.read_drafts');
  return transact(ctx, async (tx) => {
    const rows = await tx.select().from(schema.dataPolicySettings).orderBy(asc(schema.dataPolicySettings.key));
    const known = Object.keys(DATA_POLICY_VALIDATORS);
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return known.map((key) => {
      const r = byKey.get(key);
      return {
        key,
        value: r?.value ?? null,
        description: r?.description ?? DATA_POLICY_DESCRIPTIONS[key] ?? null,
        updatedBy: r?.updatedBy ?? null,
        updatedAt: r ? r.updatedAt.toISOString() : new Date(0).toISOString(),
      };
    });
  });
}

/** Number of published, rank-eligible current interpretations (the warning basis for enabling ranking). */
export async function rankEligibleEvidenceCount(ctx: AdminContext): Promise<number> {
  authorize(ctx, 'market_data.read_drafts');
  return transact(ctx, async (tx) => {
    const rows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.observationInterpretations)
      .where(
        and(
          eq(schema.observationInterpretations.isCurrent, true),
          eq(schema.observationInterpretations.publicationState, 'published'),
          eq(schema.observationInterpretations.rankEligible, true),
        ),
      );
    return rows[0]?.n ?? 0;
  });
}

export async function patchDataPolicy(
  ctx: AdminContext,
  key: string,
  input: { value: unknown; reason: string; expectedUpdatedAt?: string },
): Promise<DataPolicyDto> {
  authorize(ctx, 'market_data.policy.manage');
  const validator = DATA_POLICY_VALIDATORS[key];
  if (!validator) throw new ApiError('not_found', `unknown data policy ${key}`);
  const problem = validator(input.value);
  if (problem) throw new ApiError('validation_failed', `${key} ${problem}`, { details: [{ path: 'value', message: problem }] });
  const userId = actorId(ctx);
  const dto = await transact(ctx, async (tx) => {
    const existing = await tx.select().from(schema.dataPolicySettings).where(eq(schema.dataPolicySettings.key, key));
    const current = existing[0];
    if (current) assertUpdatedAt(current.updatedAt, input.expectedUpdatedAt);
    const [row] = await tx
      .insert(schema.dataPolicySettings)
      .values({ key, value: input.value as object, description: DATA_POLICY_DESCRIPTIONS[key] ?? null, updatedBy: userId })
      .onConflictDoUpdate({
        target: schema.dataPolicySettings.key,
        set: { value: input.value as object, updatedBy: userId, updatedAt: new Date() },
      })
      .returning();
    await recordAudit(tx, ctx.identity, {
      action: 'data_policy.updated',
      entityType: 'data_policy_setting',
      entityId: key,
      before: { value: current?.value ?? null },
      after: { value: input.value },
      reason: input.reason,
      correlationId: ctx.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'market_data.published',
      aggregateType: 'data_policy_setting',
      aggregateId: key,
      actorUserId: userId,
      payload: { key, value: input.value, reason: input.reason },
      correlationId: ctx.correlationId,
    });
    return {
      key: row!.key,
      value: row!.value,
      description: row!.description,
      updatedBy: row!.updatedBy,
      updatedAt: row!.updatedAt.toISOString(),
    };
  });
  await cacheDelete('markets');
  return dto;
}
