import 'server-only';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { ApiError } from '@simplexd/contracts';
import { schema, type Transaction } from '@simplexd/db';
import { recordAudit } from '@/lib/audit';
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

type TaskRow = typeof schema.researchTasks.$inferSelect;

export interface ResearchTaskDto {
  id: string;
  marketId: string;
  title: string;
  category: string;
  status: TaskRow['status'];
  priority: number;
  assigneeUserId: string | null;
  assigneeName: string | null;
  reviewerUserId: string | null;
  reviewerName: string | null;
  budgetNaira: number | null;
  dueDate: string | null;
  evidenceRightsNote: string | null;
  targetCount: number | null;
  completedCount: number;
  notes: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toDto(r: TaskRow, names: Map<string, string>): ResearchTaskDto {
  return {
    id: r.id,
    marketId: r.marketId,
    title: r.title,
    category: r.category,
    status: r.status,
    priority: r.priority,
    assigneeUserId: r.assigneeUserId,
    assigneeName: r.assigneeUserId ? (names.get(r.assigneeUserId) ?? null) : null,
    reviewerUserId: r.reviewerUserId,
    reviewerName: r.reviewerUserId ? (names.get(r.reviewerUserId) ?? null) : null,
    budgetNaira: r.budgetKobo === null ? null : Number(r.budgetKobo / 100n),
    dueDate: r.dueDate,
    evidenceRightsNote: r.evidenceRightsNote,
    targetCount: r.targetCount,
    completedCount: r.completedCount,
    notes: r.notes,
    completedAt: iso(r.completedAt),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

async function namesFor(tx: Transaction, ids: Array<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (unique.length === 0) return new Map();
  const rows = await tx
    .select({ id: schema.user.id, name: schema.user.name })
    .from(schema.user)
    .where(inArray(schema.user.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function assertUsers(tx: Transaction, ids: Array<string | null | undefined>): Promise<void> {
  const wanted = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (wanted.length === 0) return;
  const rows = await tx
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(inArray(schema.user.id, wanted));
  const found = new Set(rows.map((r) => r.id));
  const missing = wanted.filter((id) => !found.has(id));
  if (missing.length > 0)
    throw new ApiError('validation_failed', `unknown user id(s): ${missing.join(', ')}`);
}

export async function listResearchTasks(ctx: AdminContext, marketId: string): Promise<ResearchTaskDto[]> {
  authorize(ctx, 'market_data.read_drafts');
  return transact(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.researchTasks)
      .where(eq(schema.researchTasks.marketId, marketId))
      .orderBy(asc(schema.researchTasks.status), asc(schema.researchTasks.priority), desc(schema.researchTasks.createdAt));
    const names = await namesFor(tx, rows.flatMap((r) => [r.assigneeUserId, r.reviewerUserId]));
    return rows.map((r) => toDto(r, names));
  });
}

export interface ResearchTaskInput {
  title?: string;
  category?: string;
  priority?: number;
  assigneeUserId?: string | null;
  reviewerUserId?: string | null;
  budgetNaira?: number | null;
  dueDate?: string | null;
  evidenceRightsNote?: string | null;
  targetCount?: number | null;
  notes?: string | null;
  status?: TaskRow['status'];
  completedCount?: number;
}

function assertSeparateReviewer(assignee: string | null | undefined, reviewer: string | null | undefined): void {
  if (assignee && reviewer && assignee === reviewer)
    throw new ApiError('validation_failed', 'the reviewer must be a different person from the researcher', {
      details: [{ path: 'reviewerUserId', message: 'same as assignee' }],
    });
}

export async function createResearchTask(
  ctx: AdminContext,
  marketId: string,
  input: ResearchTaskInput & { title: string; category: string; priority: number },
): Promise<ResearchTaskDto> {
  authorize(ctx, 'market_data.edit');
  assertSeparateReviewer(input.assigneeUserId, input.reviewerUserId);
  return transact(ctx, async (tx) => {
    const market = await tx
      .select({ id: schema.markets.id })
      .from(schema.markets)
      .where(eq(schema.markets.id, marketId));
    if (!market[0]) throw notFound('market');
    await assertUsers(tx, [input.assigneeUserId, input.reviewerUserId]);
    const [row] = await tx
      .insert(schema.researchTasks)
      .values({
        marketId,
        title: input.title,
        category: input.category,
        priority: input.priority,
        assigneeUserId: input.assigneeUserId ?? null,
        reviewerUserId: input.reviewerUserId ?? null,
        budgetKobo:
          input.budgetNaira === null || input.budgetNaira === undefined
            ? null
            : BigInt(Math.round(input.budgetNaira)) * 100n,
        dueDate: input.dueDate ?? null,
        evidenceRightsNote: input.evidenceRightsNote ?? null,
        targetCount: input.targetCount ?? null,
        notes: input.notes ?? null,
        status: input.status ?? 'open',
      })
      .returning();
    const names = await namesFor(tx, [row!.assigneeUserId, row!.reviewerUserId]);
    const dto = toDto(row!, names);
    await recordAudit(tx, ctx.identity, {
      action: 'research_task.created',
      entityType: 'research_task',
      entityId: row!.id,
      after: dto,
      reason: null,
      correlationId: ctx.correlationId,
    });
    return dto;
  });
}

export async function patchResearchTask(
  ctx: AdminContext,
  marketId: string,
  taskId: string,
  input: ResearchTaskInput & { expectedUpdatedAt?: string },
): Promise<ResearchTaskDto> {
  authorize(ctx, 'market_data.edit');
  const userId = actorId(ctx);
  return transact(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.researchTasks)
      .where(and(eq(schema.researchTasks.id, taskId), eq(schema.researchTasks.marketId, marketId)));
    const current = rows[0];
    if (!current) throw notFound('research task');
    assertUpdatedAt(current.updatedAt, input.expectedUpdatedAt);
    const assignee = input.assigneeUserId === undefined ? current.assigneeUserId : input.assigneeUserId;
    const reviewer = input.reviewerUserId === undefined ? current.reviewerUserId : input.reviewerUserId;
    assertSeparateReviewer(assignee, reviewer);
    await assertUsers(tx, [input.assigneeUserId, input.reviewerUserId]);
    const nextStatus = input.status ?? current.status;
    if (nextStatus === 'done' && current.status !== 'done' && reviewer === userId && assignee === userId) {
      throw new ApiError('validation_failed', 'a task cannot be completed by its researcher without a separate reviewer');
    }
    const [updated] = await tx
      .update(schema.researchTasks)
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.assigneeUserId !== undefined ? { assigneeUserId: input.assigneeUserId } : {}),
        ...(input.reviewerUserId !== undefined ? { reviewerUserId: input.reviewerUserId } : {}),
        ...(input.budgetNaira !== undefined
          ? { budgetKobo: input.budgetNaira === null ? null : BigInt(Math.round(input.budgetNaira)) * 100n }
          : {}),
        ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
        ...(input.evidenceRightsNote !== undefined ? { evidenceRightsNote: input.evidenceRightsNote } : {}),
        ...(input.targetCount !== undefined ? { targetCount: input.targetCount } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.completedCount !== undefined ? { completedCount: input.completedCount } : {}),
        status: nextStatus,
        completedAt: nextStatus === 'done' ? (current.completedAt ?? new Date()) : null,
      })
      .where(eq(schema.researchTasks.id, taskId))
      .returning();
    const names = await namesFor(tx, [updated!.assigneeUserId, updated!.reviewerUserId, current.assigneeUserId, current.reviewerUserId]);
    const before = toDto(current, names) as unknown as Record<string, unknown>;
    const after = toDto(updated!, names) as unknown as Record<string, unknown>;
    const diff = changedFields(before, after);
    await recordAudit(tx, ctx.identity, {
      action: 'research_task.updated',
      entityType: 'research_task',
      entityId: taskId,
      before: diff.before,
      after: diff.after,
      correlationId: ctx.correlationId,
    });
    return toDto(updated!, names);
  });
}

/** Active staff members, for researcher/reviewer selection. */
export async function listStaffDirectory(
  ctx: AdminContext,
  query: { q?: string; limit: number } = { limit: 100 },
): Promise<Array<{ id: string; name: string; email: string; roles: string[] }>> {
  if (ctx.identity.actor.staffRoles.length === 0)
    throw new ApiError('forbidden', 'staff access required');
  return transact(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: schema.user.id,
        name: schema.user.name,
        email: schema.user.email,
        role: schema.staffRoles.role,
      })
      .from(schema.staffRoles)
      .innerJoin(schema.user, eq(schema.user.id, schema.staffRoles.userId))
      .where(isNull(schema.staffRoles.revokedAt))
      .orderBy(asc(schema.user.name));
    const byUser = new Map<string, { id: string; name: string; email: string; roles: string[] }>();
    for (const r of rows) {
      const entry = byUser.get(r.id) ?? { id: r.id, name: r.name, email: r.email, roles: [] };
      entry.roles.push(r.role);
      byUser.set(r.id, entry);
    }
    const q = query.q?.toLowerCase();
    return [...byUser.values()]
      .filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
      .slice(0, query.limit);
  });
}
