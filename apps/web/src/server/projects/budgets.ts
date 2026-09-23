import 'server-only';
import { and, asc, desc, eq, lt, or, sql } from 'drizzle-orm';
import {
  ApiError,
  type ApprovalPolicyDto,
  type BoqItemDto,
  type BoqItemInput,
  type BoqItemsReplace,
  type BudgetDecision,
  type BudgetVarianceDto,
  type BudgetVersionCreate,
  type BudgetVersionDto,
  type CommitmentCreate,
  type CommitmentDto,
  type Page,
} from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor, type Transaction } from '@simplexd/db';
import {
  BASELINE_BUDGET_POLICY,
  areaRateAmount,
  boqLineAmount,
  budgetVarianceToJson,
  computeBudgetVariance,
  evaluateApprovalPolicy,
  overallPercentComplete,
  requiredApprovers,
  sumBigint,
  type ApprovalPolicy,
} from '@simplexd/domain/projects';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { PROJECT_READ_CHECKS, requireProject, type ProjectAccess } from './access';
import {
  approvalsForEntity,
  assertPendingApproval,
  toApprovalDto,
  type ApprovalRow,
} from './approvals';
import {
  ctxFor,
  decodeCursor,
  invalidTransition,
  iso,
  isStaffIdentity,
  notFound,
  pageSlice,
  toKobo,
  userIdOf,
  type ServiceOptions,
} from './shared';

type BudgetRow = typeof schema.budgetVersions.$inferSelect;
type BoqRow = typeof schema.boqItems.$inferSelect;
type CommitmentRow = typeof schema.budgetCommitments.$inferSelect;

function toBoqItemDto(i: BoqRow): BoqItemDto {
  return {
    id: i.id,
    budgetVersionId: i.budgetVersionId,
    code: i.code,
    description: i.description,
    category: i.category,
    unit: i.unit,
    quantity: i.quantity,
    rateKobo: i.rateKobo.toString(),
    amountKobo: i.amountKobo.toString(),
    inclusions: i.inclusions,
    sortOrder: i.sortOrder,
  };
}

/** The approval policy of a version: the originating change order's flags, otherwise the baseline policy. */
async function policyForVersion(tx: Transaction, v: BudgetRow): Promise<ApprovalPolicy> {
  if (v.changeOrderId) {
    const [co] = await tx
      .select({
        requiresCustomerApproval: schema.changeOrders.requiresCustomerApproval,
        requiresStaffApproval: schema.changeOrders.requiresStaffApproval,
      })
      .from(schema.changeOrders)
      .where(eq(schema.changeOrders.id, v.changeOrderId));
    if (co) return co;
  }
  return BASELINE_BUDGET_POLICY;
}

function policyDto(policy: ApprovalPolicy, approvals: ApprovalRow[]): ApprovalPolicyDto {
  const e = evaluateApprovalPolicy(policy, approvals);
  return { ...policy, outcome: e.outcome, missing: e.missing };
}

async function toBudgetVersionDto(tx: Transaction, v: BudgetRow): Promise<BudgetVersionDto> {
  const items = await tx
    .select()
    .from(schema.boqItems)
    .where(eq(schema.boqItems.budgetVersionId, v.id))
    .orderBy(asc(schema.boqItems.sortOrder), asc(schema.boqItems.id));
  const approvals = await approvalsForEntity(tx, 'budget_version', v.id);
  const policy = await policyForVersion(tx, v);
  return {
    id: v.id,
    projectId: v.projectId,
    version: v.version,
    status: v.status,
    source: v.source,
    totalKobo: v.totalKobo.toString(),
    contingencyKobo: v.contingencyKobo.toString(),
    currency: v.currency,
    buildRateKoboPerM2: v.buildRateKoboPerM2?.toString() ?? null,
    areaM2: v.areaM2,
    inclusions: v.inclusions,
    notes: v.notes,
    changeOrderId: v.changeOrderId,
    approvedByCustomerUserId: v.approvedByCustomerUserId,
    approvedByStaffUserId: v.approvedByStaffUserId,
    approvedAt: iso(v.approvedAt),
    createdBy: v.createdBy,
    createdAt: v.createdAt.toISOString(),
    items: items.map(toBoqItemDto),
    approvals: approvals.map(toApprovalDto),
    approvalPolicy: policyDto(policy, approvals),
  };
}

function computeItems(items: BoqItemInput[], budgetVersionId: string) {
  const rows = items.map((it, index) => ({
    budgetVersionId,
    code: it.code ?? null,
    description: it.description,
    category: it.category ?? null,
    unit: it.unit,
    quantity: it.quantity,
    rateKobo: toKobo(it.rateKobo),
    amountKobo: boqLineAmount(it.quantity, toKobo(it.rateKobo)),
    inclusions: it.inclusions ?? null,
    sortOrder: it.sortOrder ?? index,
  }));
  return { rows, total: sumBigint(rows.map((r) => r.amountKobo)) };
}

export async function nextBudgetVersion(tx: Transaction, projectId: string): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number>`coalesce(max(${schema.budgetVersions.version}), 0)::int` })
    .from(schema.budgetVersions)
    .where(eq(schema.budgetVersions.projectId, projectId));
  return Number(row?.max ?? 0) + 1;
}

/** Creates a draft budget version; totals are always recomputed on the server. */
export async function createBudgetVersion(
  identity: RequestIdentity,
  projectId: string,
  input: BudgetVersionCreate,
  options: ServiceOptions = {},
): Promise<BudgetVersionDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await requireProject(tx, identity, projectId, [{ staff: 'projects.manage' }]);
    if (access.project.status === 'archived')
      throw invalidTransition('archived projects are read-only');
    const contingency = input.contingencyKobo ? toKobo(input.contingencyKobo) : 0n;
    let total: bigint;
    let buildRate: bigint | null = null;
    let area: string | null = null;
    let items: BoqItemInput[] = [];
    switch (input.source) {
      case 'area_rate': {
        area = input.areaM2 ?? access.project.grossFloorAreaM2;
        if (!area) {
          throw new ApiError(
            'validation_failed',
            'areaM2 is required: the project has no gross floor area',
          );
        }
        buildRate = toKobo(input.buildRateKoboPerM2);
        total = areaRateAmount(area, buildRate);
        break;
      }
      case 'boq':
        items = input.items;
        total = computeItems(items, '00000000-0000-0000-0000-000000000000').total;
        break;
      case 'quote': {
        const [qv] = await tx
          .select({
            totalKobo: schema.quoteVersions.totalKobo,
            orgId: schema.quotes.organizationId,
          })
          .from(schema.quoteVersions)
          .innerJoin(schema.quotes, eq(schema.quotes.id, schema.quoteVersions.quoteId))
          .where(eq(schema.quoteVersions.id, input.quoteVersionId));
        if (!qv || qv.orgId !== access.project.organizationId) {
          throw new ApiError('validation_failed', 'quoteVersionId not found for this organisation');
        }
        total = qv.totalKobo;
        break;
      }
      case 'manual':
        total = toKobo(input.totalKobo);
        break;
    }
    const version = await nextBudgetVersion(tx, projectId);
    const [row] = await tx
      .insert(schema.budgetVersions)
      .values({
        projectId,
        version,
        status: 'draft',
        source: input.source,
        totalKobo: total,
        contingencyKobo: contingency,
        buildRateKoboPerM2: buildRate,
        areaM2: area,
        inclusions: input.inclusions ?? null,
        notes: input.notes ?? null,
        createdBy: actorId,
      })
      .returning();
    if (items.length > 0)
      await tx.insert(schema.boqItems).values(computeItems(items, row!.id).rows);
    for (const role of requiredApprovers(BASELINE_BUDGET_POLICY)) {
      await tx.insert(schema.approvals).values({
        organizationId: access.project.organizationId,
        entityType: 'budget_version',
        entityId: row!.id,
        approverRole: role,
        status: 'pending',
        requestedBy: actorId,
      });
    }
    await recordAudit(tx, identity, {
      action: 'budget_version.created',
      entityType: 'budget_version',
      entityId: row!.id,
      organizationId: access.project.organizationId,
      after: {
        projectId,
        version,
        source: input.source,
        totalKobo: total.toString(),
        contingencyKobo: contingency.toString(),
      },
      correlationId: options.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'project.budget.drafted',
      aggregateType: 'budget_version',
      aggregateId: row!.id,
      organizationId: access.project.organizationId,
      actorUserId: actorId,
      payload: {
        projectId,
        budgetVersionId: row!.id,
        version,
        customerContactUserId: access.project.customerContactUserId,
      },
      correlationId: options.correlationId ?? null,
    });
    return toBudgetVersionDto(tx, row!);
  });
}

async function loadVersion(
  tx: Transaction,
  identity: RequestIdentity,
  versionId: string,
  checks = PROJECT_READ_CHECKS,
) {
  const [v] = await tx
    .select()
    .from(schema.budgetVersions)
    .where(eq(schema.budgetVersions.id, versionId));
  if (!v) throw notFound('budget version');
  const access = await requireProject(tx, identity, v.projectId, checks);
  return { v, access };
}

export async function getBudgetVersion(
  identity: RequestIdentity,
  versionId: string,
): Promise<BudgetVersionDto> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    const { v } = await loadVersion(tx, identity, versionId);
    return toBudgetVersionDto(tx, v);
  });
}

export async function listBudgetVersions(
  identity: RequestIdentity,
  projectId: string,
): Promise<{ items: BudgetVersionDto[] }> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    await requireProject(tx, identity, projectId, PROJECT_READ_CHECKS);
    const rows = await tx
      .select()
      .from(schema.budgetVersions)
      .where(eq(schema.budgetVersions.projectId, projectId))
      .orderBy(desc(schema.budgetVersions.version));
    const items: BudgetVersionDto[] = [];
    for (const r of rows) items.push(await toBudgetVersionDto(tx, r));
    return { items };
  });
}

/** Replaces the BOQ of a draft version that nobody has decided on yet. */
export async function replaceBoqItems(
  identity: RequestIdentity,
  versionId: string,
  input: BoqItemsReplace,
  options: ServiceOptions = {},
): Promise<BudgetVersionDto> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { v, access } = await loadVersion(tx, identity, versionId, [
      { staff: 'projects.manage' },
    ]);
    if (v.status !== 'draft')
      throw invalidTransition(`budget version ${v.version} is ${v.status} and cannot be edited`);
    const approvals = await approvalsForEntity(tx, 'budget_version', v.id);
    if (approvals.some((a) => a.status !== 'pending')) {
      throw new ApiError(
        'conflict',
        'this version already has a decision; create a new version instead',
      );
    }
    const computed = computeItems(input.items, v.id);
    await tx.delete(schema.boqItems).where(eq(schema.boqItems.budgetVersionId, v.id));
    await tx.insert(schema.boqItems).values(computed.rows);
    const [updated] = await tx
      .update(schema.budgetVersions)
      .set({ totalKobo: computed.total, source: 'boq' })
      .where(eq(schema.budgetVersions.id, v.id))
      .returning();
    await recordAudit(tx, identity, {
      action: 'budget_version.items_replaced',
      entityType: 'budget_version',
      entityId: v.id,
      organizationId: access.project.organizationId,
      before: { totalKobo: v.totalKobo.toString() },
      after: { totalKobo: computed.total.toString(), itemCount: computed.rows.length },
      correlationId: options.correlationId,
    });
    return toBudgetVersionDto(tx, updated!);
  });
}

/**
 * Records a customer or staff decision on a draft version. The version is
 * approved only when the policy is satisfied; approval supersedes the
 * previously approved version and becomes the project's approved budget.
 */
export async function decideBudgetVersion(
  identity: RequestIdentity,
  versionId: string,
  input: BudgetDecision,
  options: ServiceOptions = {},
): Promise<BudgetVersionDto> {
  const actorId = userIdOf(identity);
  const role: 'customer' | 'staff' = isStaffIdentity(identity) ? 'staff' : 'customer';
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { v, access } = await loadVersion(
      tx,
      identity,
      versionId,
      role === 'staff' ? [{ staff: 'projects.manage' }] : [{ org: 'org.change_orders.approve' }],
    );
    if (v.status !== 'draft')
      throw invalidTransition(`budget version ${v.version} is already ${v.status}`);
    const policy = await policyForVersion(tx, v);
    if (!requiredApprovers(policy).includes(role)) {
      throw invalidTransition(`the approval policy does not require a ${role} decision`);
    }
    const approvals = await approvalsForEntity(tx, 'budget_version', v.id);
    const mine = assertPendingApproval(
      approvals.find((a) => a.approverRole === role && a.status === 'pending'),
      role,
    );
    await tx
      .update(schema.approvals)
      .set({
        status: input.decision,
        approverUserId: actorId,
        decidedAt: new Date(),
        decisionNote: input.note ?? null,
      })
      .where(eq(schema.approvals.id, mine.id));
    const after = await approvalsForEntity(tx, 'budget_version', v.id);
    const evaluation = evaluateApprovalPolicy(policy, after);
    await recordAudit(tx, identity, {
      action: `budget_version.${role}_${input.decision}`,
      entityType: 'budget_version',
      entityId: v.id,
      organizationId: access.project.organizationId,
      after: { decision: input.decision, outcome: evaluation.outcome },
      reason: input.note ?? null,
      correlationId: options.correlationId,
    });
    let current = v;
    if (evaluation.outcome === 'approved') {
      current = await applyApprovedVersion(tx, identity, access, v, after, options);
    }
    await appendOutbox(tx, {
      eventType:
        evaluation.outcome === 'approved'
          ? 'project.budget.approved'
          : `project.budget.${role}_${input.decision}`,
      aggregateType: 'budget_version',
      aggregateId: v.id,
      organizationId: access.project.organizationId,
      actorUserId: actorId,
      payload: {
        projectId: v.projectId,
        budgetVersionId: v.id,
        outcome: evaluation.outcome,
        pmUserId: access.project.pmUserId,
        customerContactUserId: access.project.customerContactUserId,
      },
      correlationId: options.correlationId ?? null,
    });
    return toBudgetVersionDto(tx, current);
  });
}

/** Marks a version approved, supersedes the previous approved one and points the project at it. */
export async function applyApprovedVersion(
  tx: Transaction,
  identity: RequestIdentity,
  access: ProjectAccess,
  v: BudgetRow,
  approvals: ApprovalRow[],
  options: ServiceOptions,
): Promise<BudgetRow> {
  const customer = approvals.find((a) => a.approverRole === 'customer' && a.status === 'approved');
  const staff = approvals.find((a) => a.approverRole === 'staff' && a.status === 'approved');
  const previousId = access.project.approvedBudgetVersionId;
  if (previousId && previousId !== v.id) {
    await tx
      .update(schema.budgetVersions)
      .set({ status: 'superseded' })
      .where(
        and(eq(schema.budgetVersions.id, previousId), eq(schema.budgetVersions.status, 'approved')),
      );
  }
  const [approved] = await tx
    .update(schema.budgetVersions)
    .set({
      status: 'approved',
      approvedAt: new Date(),
      approvedByCustomerUserId: customer?.approverUserId ?? v.approvedByCustomerUserId,
      approvedByStaffUserId: staff?.approverUserId ?? v.approvedByStaffUserId,
    })
    .where(eq(schema.budgetVersions.id, v.id))
    .returning();
  await tx
    .update(schema.projects)
    .set({ approvedBudgetVersionId: v.id, version: access.project.version + 1 })
    .where(
      and(eq(schema.projects.id, v.projectId), eq(schema.projects.version, access.project.version)),
    );
  await recordAudit(tx, identity, {
    action: 'project.budget_approved',
    entityType: 'project',
    entityId: v.projectId,
    organizationId: access.project.organizationId,
    before: { approvedBudgetVersionId: previousId },
    after: { approvedBudgetVersionId: v.id, totalKobo: v.totalKobo.toString(), version: v.version },
    correlationId: options.correlationId,
  });
  return approved!;
}

function toCommitmentDto(c: CommitmentRow): CommitmentDto {
  return {
    id: c.id,
    projectId: c.projectId,
    budgetVersionId: c.budgetVersionId,
    boqItemId: c.boqItemId,
    kind: c.kind,
    description: c.description,
    amountKobo: c.amountKobo.toString(),
    currency: c.currency,
    reference: c.reference,
    counterparty: c.counterparty,
    incurredAt: c.incurredAt,
    evidenceFileId: c.evidenceFileId,
    createdBy: c.createdBy,
    createdAt: c.createdAt.toISOString(),
  };
}

/** Appends a commitment or actual (append-only; corrections are new rows). */
export async function addCommitment(
  identity: RequestIdentity,
  projectId: string,
  input: CommitmentCreate,
  options: ServiceOptions = {},
): Promise<CommitmentDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await requireProject(tx, identity, projectId, [{ staff: 'projects.manage' }]);
    if (input.boqItemId) {
      const [item] = await tx
        .select({ projectId: schema.budgetVersions.projectId })
        .from(schema.boqItems)
        .innerJoin(
          schema.budgetVersions,
          eq(schema.budgetVersions.id, schema.boqItems.budgetVersionId),
        )
        .where(eq(schema.boqItems.id, input.boqItemId));
      if (!item || item.projectId !== projectId)
        throw new ApiError('validation_failed', 'boqItemId does not belong to this project');
    }
    if (input.evidenceFileId) {
      const [file] = await tx
        .select({
          organizationId: schema.fileObjects.organizationId,
          status: schema.fileObjects.status,
        })
        .from(schema.fileObjects)
        .where(eq(schema.fileObjects.id, input.evidenceFileId));
      if (!file || (file.organizationId && file.organizationId !== access.project.organizationId)) {
        throw new ApiError('validation_failed', 'evidenceFileId not found for this organisation');
      }
    }
    const [row] = await tx
      .insert(schema.budgetCommitments)
      .values({
        projectId,
        budgetVersionId: access.project.approvedBudgetVersionId,
        boqItemId: input.boqItemId ?? null,
        kind: input.kind,
        description: input.description,
        amountKobo: toKobo(input.amountKobo),
        currency: input.currency,
        reference: input.reference ?? null,
        counterparty: input.counterparty ?? null,
        incurredAt: input.incurredAt ?? null,
        evidenceFileId: input.evidenceFileId ?? null,
        createdBy: actorId,
      })
      .returning();
    await recordAudit(tx, identity, {
      action: `budget_commitment.${input.kind}_recorded`,
      entityType: 'budget_commitment',
      entityId: row!.id,
      organizationId: access.project.organizationId,
      after: {
        projectId,
        kind: input.kind,
        amountKobo: input.amountKobo,
        reference: input.reference ?? null,
      },
      correlationId: options.correlationId,
    });
    return toCommitmentDto(row!);
  });
}

export async function listCommitments(
  identity: RequestIdentity,
  projectId: string,
  query: { cursor?: string; limit: number; kind?: 'commitment' | 'actual' },
): Promise<Page<CommitmentDto>> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    await requireProject(tx, identity, projectId, PROJECT_READ_CHECKS);
    const cursor = decodeCursor(query.cursor);
    const rows = await tx
      .select()
      .from(schema.budgetCommitments)
      .where(
        and(
          eq(schema.budgetCommitments.projectId, projectId),
          query.kind ? eq(schema.budgetCommitments.kind, query.kind) : undefined,
          cursor
            ? or(
                lt(schema.budgetCommitments.createdAt, cursor.createdAt),
                and(
                  eq(schema.budgetCommitments.createdAt, cursor.createdAt),
                  lt(schema.budgetCommitments.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.budgetCommitments.createdAt), desc(schema.budgetCommitments.id))
      .limit(query.limit + 1);
    const page = pageSlice(rows, query.limit);
    return { items: page.items.map(toCommitmentDto), nextCursor: page.nextCursor };
  });
}

/** Approved budget vs commitments vs actuals vs forecast, from the domain calculator. */
export async function getBudgetVariance(
  identity: RequestIdentity,
  projectId: string,
): Promise<BudgetVarianceDto> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    const access = await requireProject(tx, identity, projectId, PROJECT_READ_CHECKS);
    return computeVarianceFor(tx, access);
  });
}

export async function computeVarianceFor(
  tx: Transaction,
  access: ProjectAccess,
): Promise<BudgetVarianceDto> {
  const p = access.project;
  const approved = p.approvedBudgetVersionId
    ? (
        await tx
          .select()
          .from(schema.budgetVersions)
          .where(eq(schema.budgetVersions.id, p.approvedBudgetVersionId))
      )[0]
    : undefined;
  const totals = await tx
    .select({
      kind: schema.budgetCommitments.kind,
      total: sql<string>`coalesce(sum(${schema.budgetCommitments.amountKobo}), 0)::text`,
    })
    .from(schema.budgetCommitments)
    .where(eq(schema.budgetCommitments.projectId, p.id))
    .groupBy(schema.budgetCommitments.kind);
  const coRows = await tx
    .select({
      status: schema.changeOrders.status,
      delta: sql<string>`coalesce(sum(${schema.changeOrders.amountDeltaKobo}), 0)::text`,
    })
    .from(schema.changeOrders)
    .where(eq(schema.changeOrders.projectId, p.id))
    .groupBy(schema.changeOrders.status);
  const sumWhere = (statuses: string[]) =>
    coRows.filter((r) => statuses.includes(r.status)).reduce((acc, r) => acc + BigInt(r.delta), 0n);
  const tasks = await tx
    .select({ percentComplete: schema.scheduleTasks.percentComplete })
    .from(schema.scheduleTasks)
    .where(
      and(
        eq(schema.scheduleTasks.projectId, p.id),
        eq(schema.scheduleTasks.scheduleVersion, p.currentScheduleVersion),
      ),
    );
  const variance = computeBudgetVariance({
    approvedBaseKobo: approved ? approved.totalKobo : null,
    contingencyKobo: approved ? approved.contingencyKobo : 0n,
    committedKobo: BigInt(totals.find((t) => t.kind === 'commitment')?.total ?? '0'),
    actualKobo: BigInt(totals.find((t) => t.kind === 'actual')?.total ?? '0'),
    approvedChangeOrderDeltaKobo: sumWhere(['approved']),
    pendingChangeOrderDeltaKobo: sumWhere(['submitted', 'staff_review', 'customer_review']),
    percentComplete: overallPercentComplete(tasks),
  });
  return budgetVarianceToJson(variance) as BudgetVarianceDto;
}
