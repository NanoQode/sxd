import 'server-only';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import {
  ApiError,
  type ChangeOrderCreate,
  type ChangeOrderDecision,
  type ChangeOrderDto,
  type ChangeOrderUpdate,
  type ChangeOrderWithdraw,
  type Page,
} from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor, type Transaction } from '@simplexd/db';
import {
  applyChangeOrderDelta,
  evaluateApprovalPolicy,
  pendingChangeOrderStatus,
  requiredApprovers,
  shiftIsoDate,
  validateApprovalPolicy,
} from '@simplexd/domain/projects';
import { changeOrderMachine, evaluateTransition, findRule } from '@simplexd/domain/workflow';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import {
  PROJECT_READ_CHECKS,
  requireProject,
  type AccessCheck,
  type ProjectAccess,
} from './access';
import {
  approvalsForEntity,
  assertPendingApproval,
  toApprovalDto,
  type ApprovalRow,
} from './approvals';
import { nextBudgetVersion } from './budgets';
import {
  assertVersion,
  ctxFor,
  decodeCursor,
  invalidTransition,
  iso,
  isStaffIdentity,
  notFound,
  pageSlice,
  toKobo,
  userIdOf,
  versionConflict,
  type ServiceOptions,
} from './shared';

type CoRow = typeof schema.changeOrders.$inferSelect;

function toDto(co: CoRow, approvals: ApprovalRow[]): ChangeOrderDto {
  const evaluation = evaluateApprovalPolicy(co, approvals);
  return {
    id: co.id,
    organizationId: co.organizationId,
    projectId: co.projectId,
    baseBudgetVersionId: co.baseBudgetVersionId,
    number: co.number,
    title: co.title,
    description: co.description,
    amountDeltaKobo: co.amountDeltaKobo.toString(),
    scheduleDeltaDays: co.scheduleDeltaDays,
    status: co.status,
    requiresCustomerApproval: co.requiresCustomerApproval,
    requiresStaffApproval: co.requiresStaffApproval,
    appliedBudgetVersionId: co.appliedBudgetVersionId,
    submittedAt: iso(co.submittedAt),
    decidedAt: iso(co.decidedAt),
    decisionNote: co.decisionNote,
    createdBy: co.createdBy,
    version: co.version,
    createdAt: co.createdAt.toISOString(),
    updatedAt: co.updatedAt.toISOString(),
    approvals: approvals.map(toApprovalDto),
    approvalPolicy: {
      requiresCustomerApproval: co.requiresCustomerApproval,
      requiresStaffApproval: co.requiresStaffApproval,
      outcome: evaluation.outcome,
      missing: evaluation.missing,
    },
  };
}

async function withApprovals(tx: Transaction, co: CoRow): Promise<ChangeOrderDto> {
  return toDto(co, await approvalsForEntity(tx, 'change_order', co.id));
}

async function loadChangeOrder(
  tx: Transaction,
  identity: RequestIdentity,
  id: string,
  checks: AccessCheck[],
) {
  const [co] = await tx.select().from(schema.changeOrders).where(eq(schema.changeOrders.id, id));
  if (!co) throw notFound('change order');
  const access = await requireProject(tx, identity, co.projectId, checks, {
    createdBy: co.createdBy,
  });
  return { co, access };
}

export async function createChangeOrder(
  identity: RequestIdentity,
  projectId: string,
  input: ChangeOrderCreate,
  options: ServiceOptions = {},
): Promise<ChangeOrderDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await requireProject(tx, identity, projectId, [{ staff: 'projects.manage' }]);
    const policyError = validateApprovalPolicy(input);
    if (policyError) throw new ApiError('validation_failed', policyError);
    const [numRow] = await tx
      .select({ max: sql<number>`coalesce(max(${schema.changeOrders.number}), 0)::int` })
      .from(schema.changeOrders)
      .where(eq(schema.changeOrders.projectId, projectId));
    const [row] = await tx
      .insert(schema.changeOrders)
      .values({
        organizationId: access.project.organizationId,
        projectId,
        baseBudgetVersionId: access.project.approvedBudgetVersionId,
        number: Number(numRow?.max ?? 0) + 1,
        title: input.title,
        description: input.description ?? null,
        amountDeltaKobo: toKobo(input.amountDeltaKobo),
        scheduleDeltaDays: input.scheduleDeltaDays,
        requiresCustomerApproval: input.requiresCustomerApproval,
        requiresStaffApproval: input.requiresStaffApproval,
        createdBy: actorId,
      })
      .returning();
    await recordAudit(tx, identity, {
      action: 'change_order.created',
      entityType: 'change_order',
      entityId: row!.id,
      organizationId: access.project.organizationId,
      after: {
        projectId,
        number: row!.number,
        amountDeltaKobo: input.amountDeltaKobo,
        scheduleDeltaDays: input.scheduleDeltaDays,
      },
      correlationId: options.correlationId,
    });
    return withApprovals(tx, row!);
  });
}

export async function getChangeOrder(
  identity: RequestIdentity,
  id: string,
): Promise<ChangeOrderDto> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    const { co } = await loadChangeOrder(tx, identity, id, PROJECT_READ_CHECKS);
    return withApprovals(tx, co);
  });
}

export async function listChangeOrders(
  identity: RequestIdentity,
  projectId: string,
  query: { cursor?: string; limit: number; status?: CoRow['status'] },
): Promise<Page<ChangeOrderDto>> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    await requireProject(tx, identity, projectId, PROJECT_READ_CHECKS);
    const cursor = decodeCursor(query.cursor);
    const rows = await tx
      .select()
      .from(schema.changeOrders)
      .where(
        and(
          eq(schema.changeOrders.projectId, projectId),
          query.status ? eq(schema.changeOrders.status, query.status) : undefined,
          cursor
            ? or(
                lt(schema.changeOrders.createdAt, cursor.createdAt),
                and(
                  eq(schema.changeOrders.createdAt, cursor.createdAt),
                  lt(schema.changeOrders.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.changeOrders.createdAt), desc(schema.changeOrders.id))
      .limit(query.limit + 1);
    const page = pageSlice(rows, query.limit);
    const items: ChangeOrderDto[] = [];
    for (const r of page.items) items.push(await withApprovals(tx, r));
    return { items, nextCursor: page.nextCursor };
  });
}

export async function updateChangeOrder(
  identity: RequestIdentity,
  id: string,
  input: ChangeOrderUpdate,
  options: ServiceOptions = {},
): Promise<ChangeOrderDto> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { co, access } = await loadChangeOrder(tx, identity, id, [{ staff: 'projects.manage' }]);
    assertVersion(co.version, input.expectedVersion);
    if (co.status !== 'draft') throw invalidTransition('only draft change orders can be edited');
    const merged = {
      requiresCustomerApproval: input.requiresCustomerApproval ?? co.requiresCustomerApproval,
      requiresStaffApproval: input.requiresStaffApproval ?? co.requiresStaffApproval,
    };
    const policyError = validateApprovalPolicy(merged);
    if (policyError) throw new ApiError('validation_failed', policyError);
    const { expectedVersion: _v, amountDeltaKobo, ...fields } = input;
    const patch: Partial<typeof schema.changeOrders.$inferInsert> = { version: co.version + 1 };
    for (const [k, v] of Object.entries(fields))
      if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
    if (amountDeltaKobo !== undefined) patch.amountDeltaKobo = toKobo(amountDeltaKobo);
    const [updated] = await tx
      .update(schema.changeOrders)
      .set(patch)
      .where(and(eq(schema.changeOrders.id, id), eq(schema.changeOrders.version, co.version)))
      .returning();
    if (!updated) throw versionConflict(co.version);
    await recordAudit(tx, identity, {
      action: 'change_order.updated',
      entityType: 'change_order',
      entityId: id,
      organizationId: access.project.organizationId,
      before: {
        amountDeltaKobo: co.amountDeltaKobo.toString(),
        scheduleDeltaDays: co.scheduleDeltaDays,
        title: co.title,
      },
      after: {
        amountDeltaKobo: updated.amountDeltaKobo.toString(),
        scheduleDeltaDays: updated.scheduleDeltaDays,
        title: updated.title,
      },
      correlationId: options.correlationId,
    });
    return withApprovals(tx, updated);
  });
}

function assertMachine(
  co: CoRow,
  to: CoRow['status'],
  actor: 'staff' | 'customer' | 'partner' | 'system',
  reason?: string | null,
) {
  const result = evaluateTransition(changeOrderMachine, {
    from: co.status,
    to,
    actor,
    reason: reason ?? null,
  });
  if (!result.ok)
    throw invalidTransition(result.message, { code: result.code, from: co.status, to });
}

/** draft → submitted; pending approval rows are created per policy and the outstanding review state is set. */
export async function submitChangeOrder(
  identity: RequestIdentity,
  id: string,
  input: { expectedVersion: number },
  options: ServiceOptions = {},
): Promise<ChangeOrderDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { co, access } = await loadChangeOrder(tx, identity, id, [{ staff: 'projects.manage' }]);
    assertVersion(co.version, input.expectedVersion);
    assertMachine(co, 'submitted', 'staff');
    if (!access.project.approvedBudgetVersionId) {
      throw invalidTransition(
        'the project has no approved budget to change; approve a baseline first',
      );
    }
    for (const role of requiredApprovers(co)) {
      await tx.insert(schema.approvals).values({
        organizationId: access.project.organizationId,
        entityType: 'change_order',
        entityId: co.id,
        approverRole: role,
        status: 'pending',
        requestedBy: actorId,
      });
    }
    // The machine routes submitted → staff_review (system); when the policy needs no staff
    // approval the outstanding state is customer_review (policy extension, see docs/workflows/projects.md).
    const pendingState = pendingChangeOrderStatus(co, []);
    const [updated] = await tx
      .update(schema.changeOrders)
      .set({
        status: pendingState,
        submittedAt: new Date(),
        baseBudgetVersionId: access.project.approvedBudgetVersionId,
        version: co.version + 1,
      })
      .where(and(eq(schema.changeOrders.id, id), eq(schema.changeOrders.version, co.version)))
      .returning();
    if (!updated) throw versionConflict(co.version);
    await recordAudit(tx, identity, {
      action: 'change_order.submitted',
      entityType: 'change_order',
      entityId: id,
      organizationId: access.project.organizationId,
      before: { status: co.status },
      after: { status: pendingState, required: requiredApprovers(co) },
      correlationId: options.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'project.change_order.submitted',
      aggregateType: 'change_order',
      aggregateId: id,
      organizationId: access.project.organizationId,
      actorUserId: actorId,
      payload: {
        projectId: co.projectId,
        changeOrderId: id,
        required: requiredApprovers(co),
        pmUserId: access.project.pmUserId,
        customerContactUserId: access.project.customerContactUserId,
      },
      correlationId: options.correlationId ?? null,
    });
    return withApprovals(tx, updated);
  });
}

/**
 * Records a customer (`org.change_orders.approve`) or staff
 * (`change_orders.staff_approve`, never the creator) decision. Only when every
 * required approval is present does the approved budget change: a new approved
 * budget version is created from the current approved total plus the delta and
 * the forecast completion date shifts by the schedule delta. Any rejection
 * rejects the change order and leaves the budget untouched.
 */
export async function decideChangeOrder(
  identity: RequestIdentity,
  id: string,
  input: ChangeOrderDecision,
  options: ServiceOptions = {},
): Promise<ChangeOrderDto> {
  const actorId = userIdOf(identity);
  if (input.approverRole === 'staff' && !isStaffIdentity(identity)) {
    throw new ApiError('forbidden', 'only staff can record a staff decision');
  }
  if (input.approverRole === 'customer' && isStaffIdentity(identity)) {
    throw new ApiError('forbidden', 'staff cannot record the customer decision');
  }
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const checks: AccessCheck[] =
      input.approverRole === 'staff'
        ? [{ staff: 'change_orders.staff_approve' }]
        : [{ org: 'org.change_orders.approve' }];
    const { co, access } = await loadChangeOrder(tx, identity, id, checks);
    if (input.approverRole === 'staff' && co.createdBy === actorId) {
      throw new ApiError('forbidden', 'the creator of a change order cannot approve it as staff');
    }
    assertVersion(co.version, input.expectedVersion);
    if (!['submitted', 'staff_review', 'customer_review'].includes(co.status)) {
      throw invalidTransition(`change order is ${co.status}; no decision is pending`);
    }
    if (!requiredApprovers(co).includes(input.approverRole)) {
      throw invalidTransition(
        `the approval policy does not require a ${input.approverRole} decision`,
      );
    }
    const approvals = await approvalsForEntity(tx, 'change_order', co.id);
    const mine = assertPendingApproval(
      approvals.find((a) => a.approverRole === input.approverRole && a.status === 'pending'),
      input.approverRole,
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
    const after = await approvalsForEntity(tx, 'change_order', co.id);
    const evaluation = evaluateApprovalPolicy(co, after);
    const actorKind = input.approverRole === 'staff' ? 'staff' : 'customer';

    let nextStatus: CoRow['status'];
    if (evaluation.outcome === 'rejected') {
      assertMachine(co, 'rejected', actorKind, input.note ?? 'rejected');
      nextStatus = 'rejected';
    } else if (evaluation.outcome === 'approved') {
      // customer_review → approved is the machine's customer transition; a staff approval that
      // completes the policy (customer already approved, or no customer approval required) is the
      // documented policy extension.
      if (co.status === 'customer_review' && actorKind === 'customer')
        assertMachine(co, 'approved', 'customer');
      nextStatus = 'approved';
    } else {
      nextStatus = pendingChangeOrderStatus(co, after);
      if (
        co.status === 'staff_review' &&
        nextStatus === 'customer_review' &&
        actorKind === 'staff'
      ) {
        assertMachine(co, 'customer_review', 'staff');
      }
    }

    const decided = nextStatus === 'approved' || nextStatus === 'rejected';
    const [updated] = await tx
      .update(schema.changeOrders)
      .set({
        status: nextStatus,
        decidedAt: decided ? new Date() : null,
        decisionNote: decided ? (input.note ?? null) : co.decisionNote,
        version: co.version + 1,
      })
      .where(and(eq(schema.changeOrders.id, id), eq(schema.changeOrders.version, co.version)))
      .returning();
    if (!updated) throw versionConflict(co.version);
    let final = updated;
    if (nextStatus === 'approved')
      final = await applyApprovedChangeOrder(tx, identity, access, updated, after, options);

    await recordAudit(tx, identity, {
      action: `change_order.${input.approverRole}_${input.decision}`,
      entityType: 'change_order',
      entityId: id,
      organizationId: access.project.organizationId,
      before: { status: co.status },
      after: { status: nextStatus, outcome: evaluation.outcome, missing: evaluation.missing },
      reason: input.note ?? null,
      correlationId: options.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'project.change_order.decided',
      aggregateType: 'change_order',
      aggregateId: id,
      organizationId: access.project.organizationId,
      actorUserId: actorId,
      payload: {
        projectId: co.projectId,
        changeOrderId: id,
        approverRole: input.approverRole,
        decision: input.decision,
        status: nextStatus,
        pmUserId: access.project.pmUserId,
        customerContactUserId: access.project.customerContactUserId,
      },
      correlationId: options.correlationId ?? null,
    });
    return withApprovals(tx, final);
  });
}

async function applyApprovedChangeOrder(
  tx: Transaction,
  identity: RequestIdentity,
  access: ProjectAccess,
  co: CoRow,
  approvals: ApprovalRow[],
  options: ServiceOptions,
): Promise<CoRow> {
  const p = access.project;
  const currentId = p.approvedBudgetVersionId;
  if (!currentId) throw invalidTransition('the project has no approved budget to change');
  const [base] = await tx
    .select()
    .from(schema.budgetVersions)
    .where(eq(schema.budgetVersions.id, currentId));
  if (!base) throw invalidTransition('the approved budget version is missing');
  let total: bigint;
  try {
    total = applyChangeOrderDelta(base.totalKobo, co.amountDeltaKobo);
  } catch (err) {
    throw new ApiError('validation_failed', (err as Error).message);
  }
  const customer = approvals.find((a) => a.approverRole === 'customer' && a.status === 'approved');
  const staff = approvals.find((a) => a.approverRole === 'staff' && a.status === 'approved');
  const version = await nextBudgetVersion(tx, p.id);
  const [created] = await tx
    .insert(schema.budgetVersions)
    .values({
      projectId: p.id,
      version,
      status: 'approved',
      source: 'manual',
      totalKobo: total,
      contingencyKobo: base.contingencyKobo,
      currency: base.currency,
      buildRateKoboPerM2: base.buildRateKoboPerM2,
      areaM2: base.areaM2,
      inclusions: base.inclusions,
      notes: `Change order #${co.number} applied: base ${base.totalKobo.toString()} kobo (version ${base.version}) ${co.amountDeltaKobo < 0n ? '-' : '+'} ${(co.amountDeltaKobo < 0n ? -co.amountDeltaKobo : co.amountDeltaKobo).toString()} kobo`,
      changeOrderId: co.id,
      approvedByCustomerUserId: customer?.approverUserId ?? null,
      approvedByStaffUserId: staff?.approverUserId ?? null,
      approvedAt: new Date(),
      createdBy: identity.session?.user.id ?? null,
    })
    .returning();
  await tx
    .update(schema.budgetVersions)
    .set({ status: 'superseded' })
    .where(eq(schema.budgetVersions.id, base.id));
  const forecast = shiftIsoDate(
    p.forecastCompletionDate ?? p.targetCompletionDate,
    co.scheduleDeltaDays,
  );
  const [project] = await tx
    .update(schema.projects)
    .set({
      approvedBudgetVersionId: created!.id,
      forecastCompletionDate: forecast,
      version: p.version + 1,
    })
    .where(and(eq(schema.projects.id, p.id), eq(schema.projects.version, p.version)))
    .returning();
  if (!project) throw versionConflict(p.version);
  const [applied] = await tx
    .update(schema.changeOrders)
    .set({ appliedBudgetVersionId: created!.id })
    .where(eq(schema.changeOrders.id, co.id))
    .returning();
  await recordAudit(tx, identity, {
    action: 'change_order.applied',
    entityType: 'project',
    entityId: p.id,
    organizationId: p.organizationId,
    before: {
      approvedBudgetVersionId: base.id,
      totalKobo: base.totalKobo.toString(),
      forecastCompletionDate: p.forecastCompletionDate,
    },
    after: {
      approvedBudgetVersionId: created!.id,
      totalKobo: total.toString(),
      forecastCompletionDate: forecast,
      changeOrderId: co.id,
    },
    correlationId: options.correlationId,
  });
  return applied!;
}

/** The creator withdraws before any decision. */
export async function withdrawChangeOrder(
  identity: RequestIdentity,
  id: string,
  input: ChangeOrderWithdraw,
  options: ServiceOptions = {},
): Promise<ChangeOrderDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { co, access } = await loadChangeOrder(tx, identity, id, [{ staff: 'projects.manage' }]);
    assertVersion(co.version, input.expectedVersion);
    if (co.createdBy !== actorId)
      throw new ApiError('forbidden', 'only the creator can withdraw a change order');
    const approvals = await approvalsForEntity(tx, 'change_order', co.id);
    if (approvals.some((a) => a.status !== 'pending')) {
      throw invalidTransition(
        'a decision was already recorded; the change order can no longer be withdrawn',
      );
    }
    if (!findRule(changeOrderMachine, co.status, 'withdrawn'))
      throw invalidTransition(`change order is ${co.status}`);
    assertMachine(co, 'withdrawn', 'staff', input.reason);
    for (const a of approvals) {
      await tx
        .update(schema.approvals)
        .set({ status: 'withdrawn', decidedAt: new Date() })
        .where(eq(schema.approvals.id, a.id));
    }
    const [updated] = await tx
      .update(schema.changeOrders)
      .set({
        status: 'withdrawn',
        decidedAt: new Date(),
        decisionNote: input.reason,
        version: co.version + 1,
      })
      .where(and(eq(schema.changeOrders.id, id), eq(schema.changeOrders.version, co.version)))
      .returning();
    if (!updated) throw versionConflict(co.version);
    await recordAudit(tx, identity, {
      action: 'change_order.withdrawn',
      entityType: 'change_order',
      entityId: id,
      organizationId: access.project.organizationId,
      before: { status: co.status },
      after: { status: 'withdrawn' },
      reason: input.reason,
      correlationId: options.correlationId,
    });
    return withApprovals(tx, updated);
  });
}
