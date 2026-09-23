import 'server-only';
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import {
  ApiError,
  type Page,
  type WorkOrderCreate,
  type WorkOrderDto,
  type WorkOrderEvidence,
  type WorkOrderListQuery,
} from '@simplexd/contracts';
import { appendOutbox, getDb, schema, systemContext, withActor, type Database, type DbExecutor } from '@simplexd/db';
import { postJournal } from '@simplexd/finance';
import { maintenanceExpenseRecoverable } from '@simplexd/domain/ledger';
import { assertAllowed, authorizeAny, authorizePartner, authorizeTenant, type ResourceRef } from '@simplexd/domain/authz';
import { isSlaBreached, nextServiceDate, slaDueAt } from '@simplexd/domain/rentals';
import { evaluateTransition, workOrderMachine, type ActorKind } from '@simplexd/domain/workflow';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { isFeatureEnabled } from '@/lib/features';
import {
  FEATURES,
  activePartyUserIds,
  ctxFor,
  decodeCursor,
  elevated,
  encodeCursor,
  isStaffIdentity,
  iso,
  kobo,
  loadParties,
  requireUserId,
  today,
  userNames,
  versionConflict,
  type ServiceOptions,
} from '@/server/rentals/shared';

/**
 * Maintenance tickets and work orders. Owners (`org.maintenance.request`),
 * tenants (`tenant.maintenance.request`, on their own lease) and staff
 * (`maintenance.manage`) raise them; staff triage and dispatch a contractor
 * (an `assignments` row for the partner user); the assignee works and
 * attaches evidence; the owner approves the cost; verification records the
 * recoverable expense journal (`work_order:<id>:expense`); closing hands the
 * recovery to the owner statement. Every step is a `workOrderMachine`
 * transition with an audit entry and an outbox event.
 */

export type WorkOrderRow = typeof schema.workOrders.$inferSelect;
type WorkOrderInsert = typeof schema.workOrders.$inferInsert;

export const STAFF_READ = ['maintenance.manage', 'customers.read', 'rentals.manage', 'estates.manage'] as const;

interface WorkOrderAccess {
  row: WorkOrderRow;
  viewer: 'staff' | 'customer' | 'tenant' | 'assignee';
  ref: ResourceRef;
}

function actorKind(identity: RequestIdentity, viewer: WorkOrderAccess['viewer']): ActorKind {
  if (viewer === 'staff') return 'staff';
  if (viewer === 'assignee') return isStaffIdentity(identity) ? 'staff' : 'partner';
  if (viewer === 'tenant') return 'tenant';
  return 'customer';
}

export async function loadWorkOrder(tx: DbExecutor, id: string): Promise<WorkOrderRow | null> {
  const rows = await tx.select().from(schema.workOrders).where(eq(schema.workOrders.id, id));
  return rows[0] ?? null;
}

/**
 * Resolves how the caller relates to a visible work order. Row-level
 * security already hid rows the caller has no relationship with; this
 * classifies the relationship for the transition rules.
 */
export async function requireWorkOrder(tx: DbExecutor, identity: RequestIdentity, id: string): Promise<WorkOrderAccess> {
  const userId = requireUserId(identity);
  const row = await loadWorkOrder(tx, id);
  if (!row) throw new ApiError('not_found', 'work order not found');
  const partyIds = row.leaseId ? activePartyUserIds(await loadParties(tx, row.leaseId)) : [];
  const ref: ResourceRef = {
    type: 'work_order',
    id: row.id,
    organizationId: row.organizationId,
    createdBy: row.reportedByUserId,
    assigneeUserIds: [row.assigneeUserId, ...partyIds].filter((v): v is string => Boolean(v)),
  };
  if (isStaffIdentity(identity)) {
    const decision = authorizeAny(identity.actor, STAFF_READ.map((staff) => ({ staff })), ref);
    if (decision.allowed) return { row, viewer: 'staff', ref };
  }
  if (row.assigneeUserId === userId) {
    if (identity.actor.isPartner) assertAllowed(authorizePartner(identity.actor, 'partner.assignments.view', ref));
    return { row, viewer: 'assignee', ref };
  }
  if (partyIds.includes(userId) || (row.reportedByUserId === userId && !identity.actor.memberships.some((m) => m.organizationId === row.organizationId))) {
    assertAllowed(authorizeTenant(identity.actor, 'tenant.maintenance.request', { ...ref, assigneeUserIds: [userId] }));
    return { row, viewer: 'tenant', ref };
  }
  assertAllowed(authorizeAny(identity.actor, [{ org: 'org.read' }], ref));
  return { row, viewer: 'customer', ref };
}

async function evidenceFor(tx: DbExecutor, ids: string[]) {
  if (ids.length === 0) return new Map<string, WorkOrderDto['evidence']>();
  const rows = await tx
    .select()
    .from(schema.evidence)
    .where(inArray(schema.evidence.workOrderId, ids))
    .orderBy(asc(schema.evidence.receivedAt));
  const out = new Map<string, WorkOrderDto['evidence']>();
  for (const e of rows) {
    const list = out.get(e.workOrderId!) ?? [];
    list.push({
      id: e.id,
      fileId: e.fileId,
      kind: e.kind,
      caption: e.caption,
      capturedAt: iso(e.capturedAt),
      uploaderUserId: e.uploaderUserId,
      receivedAt: e.receivedAt.toISOString(),
    });
    out.set(e.workOrderId!, list);
  }
  return out;
}

export async function toDtos(tx: DbExecutor, rows: WorkOrderRow[], now: Date = new Date()): Promise<WorkOrderDto[]> {
  const [names, evidence] = await Promise.all([userNames(tx, rows.map((r) => r.assigneeUserId)), evidenceFor(tx, rows.map((r) => r.id))]);
  return rows.map((r) => ({
    id: r.id,
    organizationId: r.organizationId,
    propertyId: r.propertyId,
    unitId: r.unitId,
    leaseId: r.leaseId,
    assetId: r.assetId,
    estateId: r.estateId,
    reportedByUserId: r.reportedByUserId,
    title: r.title,
    description: r.description,
    category: r.category,
    priority: r.priority,
    status: r.status,
    assigneeUserId: r.assigneeUserId,
    assigneeName: r.assigneeUserId ? (names.get(r.assigneeUserId) ?? null) : null,
    estimateKobo: kobo(r.estimateKobo),
    approvedAmountKobo: kobo(r.approvedAmountKobo),
    approvedBy: r.approvedBy,
    approvedAt: iso(r.approvedAt),
    actualCostKobo: kobo(r.actualCostKobo),
    expenseJournalId: r.expenseJournalId,
    slaDueAt: iso(r.slaDueAt),
    slaBreached: isSlaBreached(r.status, r.slaDueAt, now),
    recurring: (r.recurring as Record<string, unknown> | null) ?? null,
    completedAt: iso(r.completedAt),
    verifiedBy: r.verifiedBy,
    verifiedAt: iso(r.verifiedAt),
    evidence: evidence.get(r.id) ?? [],
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

async function one(tx: DbExecutor, row: WorkOrderRow): Promise<WorkOrderDto> {
  return (await toDtos(tx, [row]))[0]!;
}

/* ---------------------------------------------------------------------- */
/* Create                                                                  */
/* ---------------------------------------------------------------------- */

export async function createWorkOrder(
  identity: RequestIdentity,
  input: WorkOrderCreate,
  options: ServiceOptions = {},
): Promise<WorkOrderDto> {
  const userId = requireUserId(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const [property] = await tx
      .select({ id: schema.properties.id, organizationId: schema.properties.organizationId, estateId: schema.properties.estateId })
      .from(schema.properties)
      .where(eq(schema.properties.id, input.propertyId));
    if (!property) throw new ApiError('not_found', 'property not found');
    let viewer: WorkOrderAccess['viewer'] = 'customer';
    let leaseId = input.leaseId ?? null;
    if (leaseId) {
      const [lease] = await tx.select().from(schema.leases).where(eq(schema.leases.id, leaseId));
      if (!lease || lease.propertyId !== property.id) throw new ApiError('not_found', 'lease not found');
      const partyIds = activePartyUserIds(await loadParties(tx, leaseId));
      if (partyIds.includes(userId) && !isStaffIdentity(identity)) {
        assertAllowed(authorizeTenant(identity.actor, 'tenant.maintenance.request', { type: 'lease', id: leaseId, assigneeUserIds: partyIds }));
        viewer = 'tenant';
      }
    }
    if (viewer !== 'tenant') {
      const decision = authorizeAny(
        identity.actor,
        [{ staff: 'maintenance.manage' }, { org: 'org.maintenance.request' }],
        { type: 'work_order', organizationId: property.organizationId },
      );
      assertAllowed(decision);
      viewer = decision.via.startsWith('staff') ? 'staff' : 'customer';
    }
    if (input.unitId) {
      const [unit] = await tx.select({ id: schema.units.id }).from(schema.units).where(and(eq(schema.units.id, input.unitId), eq(schema.units.propertyId, property.id)));
      if (!unit) throw new ApiError('validation_failed', 'unit does not belong to the property');
    }
    if (input.assetId) {
      if (!isFeatureEnabled(identity, FEATURES.preventiveMaintenance))
        throw new ApiError('feature_disabled', 'asset-linked work orders need preventive maintenance', { details: { feature: FEATURES.preventiveMaintenance } });
      const [asset] = await tx.select({ id: schema.assets.id }).from(schema.assets).where(and(eq(schema.assets.id, input.assetId), eq(schema.assets.propertyId, property.id)));
      if (!asset) throw new ApiError('validation_failed', 'asset does not belong to the property');
    }
    const estateId = input.estateId ?? property.estateId ?? null;
    if (input.estateId && !isFeatureEnabled(identity, FEATURES.estateManagement))
      throw new ApiError('feature_disabled', 'estate issues need estate management', { details: { feature: FEATURES.estateManagement } });
    if (viewer === 'tenant') leaseId = input.leaseId!;
    const now = new Date();
    const [row] = await tx
      .insert(schema.workOrders)
      .values({
        organizationId: property.organizationId,
        propertyId: property.id,
        unitId: input.unitId ?? null,
        leaseId,
        assetId: input.assetId ?? null,
        estateId,
        reportedByUserId: userId,
        title: input.title,
        description: input.description ?? null,
        category: input.category,
        priority: input.priority,
        status: 'requested',
        slaDueAt: slaDueAt(input.priority, now),
      })
      .returning();
    await recordAudit(tx, identity, {
      action: 'work_order.requested',
      entityType: 'work_order',
      entityId: row!.id,
      organizationId: property.organizationId,
      after: { title: input.title, priority: input.priority, leaseId, viewer },
      correlationId: options.correlationId,
    });
    await emitTransition(tx, identity, row!, null, 'requested', options);
    return one(tx, row!);
  });
}

async function emitTransition(
  tx: DbExecutor,
  identity: RequestIdentity | null,
  row: WorkOrderRow,
  from: WorkOrderRow['status'] | null,
  to: WorkOrderRow['status'],
  options: ServiceOptions,
): Promise<void> {
  await appendOutbox(tx, {
    eventType: 'work_order.transitioned',
    aggregateType: 'work_order',
    aggregateId: row.id,
    organizationId: row.organizationId,
    actorUserId: identity?.session?.user.id ?? null,
    payload: { workOrderId: row.id, from, to, title: row.title, priority: row.priority },
    correlationId: options.correlationId ?? null,
  });
}

/* ---------------------------------------------------------------------- */
/* Transitions                                                             */
/* ---------------------------------------------------------------------- */

interface TransitionInput {
  to: WorkOrderRow['status'];
  expectedVersion: number;
  reason?: string | null;
  patch?: Partial<WorkOrderInsert>;
  /** Extra guard evaluated after the machine accepted the transition. */
  guard?: (tx: DbExecutor, access: WorkOrderAccess) => void | Promise<void>;
  allow?: Array<WorkOrderAccess['viewer']>;
  action?: string;
}

async function transition(
  identity: RequestIdentity,
  id: string,
  input: TransitionInput,
  options: ServiceOptions,
): Promise<WorkOrderDto> {
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await requireWorkOrder(tx, identity, id);
    const { row, viewer } = access;
    if (row.version !== input.expectedVersion) throw versionConflict(row.version);
    if (input.allow && !input.allow.includes(viewer)) throw new ApiError('forbidden', `a ${viewer} cannot move a work order to ${input.to}`);
    const decision = evaluateTransition(workOrderMachine, { from: row.status, to: input.to, actor: actorKind(identity, viewer), reason: input.reason ?? null });
    if (!decision.ok) throw new ApiError('invalid_transition', decision.message, { details: { code: decision.code } });
    if (decision.rule.permission === 'maintenance.manage') assertAllowed(authorizeAny(identity.actor, [{ staff: 'maintenance.manage' }], access.ref));
    if (decision.rule.permission === 'org.change_orders.approve') assertAllowed(authorizeAny(identity.actor, [{ org: 'org.change_orders.approve' }], access.ref));
    if (input.guard) await input.guard(tx, access);
    const [updated] = await tx
      .update(schema.workOrders)
      .set({ status: input.to, version: row.version + 1, ...(input.patch ?? {}) })
      .where(and(eq(schema.workOrders.id, id), eq(schema.workOrders.version, row.version)))
      .returning();
    if (!updated) throw versionConflict();
    await recordAudit(tx, identity, {
      action: input.action ?? `work_order.${input.to}`,
      entityType: 'work_order',
      entityId: id,
      organizationId: row.organizationId,
      before: { status: row.status, version: row.version },
      after: { status: input.to, version: updated.version, ...(input.patch ?? {}) },
      reason: input.reason ?? null,
      correlationId: options.correlationId,
    });
    await emitTransition(tx, identity, updated, row.status, input.to, options);
    return one(tx, updated);
  });
}

export function triageWorkOrder(
  identity: RequestIdentity,
  id: string,
  input: { priority?: WorkOrderRow['priority']; category?: string; estimateKobo?: string | null; expectedVersion: number },
  options: ServiceOptions = {},
): Promise<WorkOrderDto> {
  return transition(identity, id, {
    to: 'triaged',
    expectedVersion: input.expectedVersion,
    allow: ['staff'],
    patch: {
      ...(input.priority ? { priority: input.priority, slaDueAt: slaDueAt(input.priority, new Date()) } : {}),
      ...(input.category ? { category: input.category } : {}),
      ...(input.estimateKobo !== undefined ? { estimateKobo: input.estimateKobo ? BigInt(input.estimateKobo) : null } : {}),
    },
  }, options);
}

/** Dispatches a contractor: the assignee (staff or registered partner) gets an accepted `contractor` assignment. */
export async function assignWorkOrder(
  identity: RequestIdentity,
  id: string,
  input: { assigneeUserId: string; instructions?: string | null; expectedVersion: number },
  options: ServiceOptions = {},
): Promise<WorkOrderDto> {
  const userId = requireUserId(identity);
  return transition(identity, id, {
    to: 'assigned',
    expectedVersion: input.expectedVersion,
    allow: ['staff'],
    patch: { assigneeUserId: input.assigneeUserId },
    guard: async (tx, access) => {
      {
        const [staff] = await tx.select({ id: schema.staffRoles.id }).from(schema.staffRoles).where(and(eq(schema.staffRoles.userId, input.assigneeUserId), isNull(schema.staffRoles.revokedAt))).limit(1);
        const [partner] = staff ? [] : await tx.select({ id: schema.partnerProfiles.id }).from(schema.partnerProfiles).where(eq(schema.partnerProfiles.userId, input.assigneeUserId));
        if (!staff && !partner)
          throw new ApiError('validation_failed', 'assignee must be a staff member or a registered partner', { details: [{ path: 'assigneeUserId', message: 'not staff or partner' }] });
        await tx.insert(schema.assignments).values({
          organizationId: access.row.organizationId,
          assigneeUserId: input.assigneeUserId,
          role: 'contractor',
          status: 'accepted',
          instructions: input.instructions ?? `Work order ${access.row.id}: ${access.row.title}`,
          assignedBy: userId,
          respondedAt: new Date(),
        });
      }
    },
  }, options);
}

export function startWorkOrder(identity: RequestIdentity, id: string, input: { expectedVersion: number }, options: ServiceOptions = {}) {
  return transition(identity, id, { to: 'in_progress', expectedVersion: input.expectedVersion, allow: ['staff', 'assignee'] }, options);
}

export function requestApproval(
  identity: RequestIdentity,
  id: string,
  input: { estimateKobo: string; note?: string | null; expectedVersion: number },
  options: ServiceOptions = {},
) {
  return transition(identity, id, {
    to: 'awaiting_approval',
    expectedVersion: input.expectedVersion,
    allow: ['staff', 'assignee'],
    patch: { estimateKobo: BigInt(input.estimateKobo) },
    action: 'work_order.approval_requested',
  }, options);
}

export function approveWorkOrder(
  identity: RequestIdentity,
  id: string,
  input: { approvedAmountKobo: string; expectedVersion: number },
  options: ServiceOptions = {},
) {
  const userId = requireUserId(identity);
  return transition(identity, id, {
    to: 'approved',
    expectedVersion: input.expectedVersion,
    allow: ['customer'],
    patch: { approvedAmountKobo: BigInt(input.approvedAmountKobo), approvedBy: userId, approvedAt: new Date() },
  }, options);
}

export function rejectWorkOrder(
  identity: RequestIdentity,
  id: string,
  input: { reason: string; expectedVersion: number },
  options: ServiceOptions = {},
) {
  return transition(identity, id, { to: 'rejected', expectedVersion: input.expectedVersion, reason: input.reason, allow: ['staff', 'customer'] }, options);
}

export function cancelWorkOrder(
  identity: RequestIdentity,
  id: string,
  input: { reason: string; expectedVersion: number },
  options: ServiceOptions = {},
) {
  return transition(identity, id, { to: 'cancelled', expectedVersion: input.expectedVersion, reason: input.reason, allow: ['staff', 'customer', 'tenant'] }, options);
}

/** Evidence files (photos, invoices) from the assignee or staff. Files must be clean/uploaded and belong to the organisation or the uploader. */
export async function addEvidence(
  identity: RequestIdentity,
  id: string,
  input: WorkOrderEvidence,
  options: ServiceOptions = {},
): Promise<WorkOrderDto> {
  const userId = requireUserId(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await requireWorkOrder(tx, identity, id);
    if (!['staff', 'assignee'].includes(access.viewer)) throw new ApiError('forbidden', 'only the assignee or staff attach evidence');
    if (!['assigned', 'in_progress', 'approved', 'awaiting_approval'].includes(access.row.status))
      throw new ApiError('invalid_transition', `evidence is attached while work is open (work order is ${access.row.status})`);
    const files = await tx.select().from(schema.fileObjects).where(inArray(schema.fileObjects.id, input.fileIds));
    for (const fileId of input.fileIds) {
      const file = files.find((f) => f.id === fileId);
      if (!file) throw new ApiError('validation_failed', 'file not found', { details: [{ path: 'fileIds', message: fileId }] });
      if (['infected', 'scan_failed', 'rejected', 'deleted'].includes(file.status))
        throw new ApiError('file_quarantined', 'this file is not available', { details: { fileId } });
      if (file.organizationId !== access.row.organizationId && file.ownerUserId !== userId)
        throw new ApiError('validation_failed', 'file belongs to another organisation', { details: [{ path: 'fileIds', message: fileId }] });
      await tx.insert(schema.evidence).values({
        organizationId: access.row.organizationId,
        workOrderId: id,
        fileId,
        kind: file.declaredMime?.startsWith('image/') ? 'photo' : file.declaredMime?.startsWith('video/') ? 'video' : 'document',
        caption: input.caption ?? null,
        capturedAt: input.capturedAt ? new Date(input.capturedAt) : null,
        uploaderUserId: userId,
        checksumSha256: file.checksumSha256 ?? '',
      });
    }
    await recordAudit(tx, identity, {
      action: 'work_order.evidence_added',
      entityType: 'work_order',
      entityId: id,
      organizationId: access.row.organizationId,
      after: { fileIds: input.fileIds },
      correlationId: options.correlationId,
    });
    return one(tx, access.row);
  });
}

export function completeWorkOrder(
  identity: RequestIdentity,
  id: string,
  input: { actualCostKobo?: string | null; note?: string | null; expectedVersion: number },
  options: ServiceOptions = {},
) {
  return transition(identity, id, {
    to: 'completed',
    expectedVersion: input.expectedVersion,
    allow: ['staff', 'assignee'],
    patch: { completedAt: new Date(), ...(input.actualCostKobo ? { actualCostKobo: BigInt(input.actualCostKobo) } : {}) },
    guard: async (tx, access) => {
      const [count] = await tx
        .select({ id: schema.evidence.id })
        .from(schema.evidence)
        .where(eq(schema.evidence.workOrderId, access.row.id))
        .limit(1);
      if (!count) throw new ApiError('insufficient_evidence', 'attach at least one piece of evidence before completing the work');
    },
  }, options);
}

/**
 * Verification by staff or the owner records the recoverable expense
 * (`Dr 5200 / Cr 2400`) under the system context; the amount is the cost
 * given, else the actual cost, else the approved amount. Zero-cost work is
 * verified without a journal.
 */
export async function verifyWorkOrder(
  identity: RequestIdentity,
  id: string,
  input: { costKobo?: string | null; expectedVersion: number },
  options: ServiceOptions = {},
): Promise<WorkOrderDto> {
  const userId = requireUserId(identity);
  const ctx = ctxFor(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const access = await requireWorkOrder(tx, identity, id);
    const { row, viewer } = access;
    if (row.version !== input.expectedVersion) throw versionConflict(row.version);
    if (!['staff', 'customer'].includes(viewer)) throw new ApiError('forbidden', 'only staff or the owner verify completed work');
    const decision = evaluateTransition(workOrderMachine, { from: row.status, to: 'verified', actor: actorKind(identity, viewer) });
    if (!decision.ok) throw new ApiError('invalid_transition', decision.message);
    const cost = input.costKobo ? BigInt(input.costKobo) : (row.actualCostKobo ?? row.approvedAmountKobo ?? 0n);
    if (row.approvedAmountKobo !== null && cost > row.approvedAmountKobo && viewer !== 'customer')
      throw new ApiError('validation_failed', 'cost exceeds the owner-approved amount; the owner must approve the higher cost', {
        details: { approvedAmountKobo: row.approvedAmountKobo.toString(), costKobo: cost.toString() },
      });
    let journalId: string | null = null;
    if (cost > 0n) {
      const estateSegment = row.estateId
        ? (await tx.select({ s: schema.estates.ledgerSegment }).from(schema.estates).where(eq(schema.estates.id, row.estateId)))[0]?.s ?? null
        : null;
      const [supplier] = row.assigneeUserId
        ? await tx.select({ organizationId: schema.partnerProfiles.organizationId }).from(schema.partnerProfiles).where(eq(schema.partnerProfiles.userId, row.assigneeUserId))
        : [];
      journalId = await elevated(tx, ctx, async () => {
        const posted = await postJournal(
          tx,
          maintenanceExpenseRecoverable({
            workOrder: { id: row.id, organizationId: row.organizationId, currency: 'NGN', amountKobo: cost, supplierOrganizationId: supplier?.organizationId ?? null },
            estateSegment,
          }),
          { postedBy: userId },
        );
        return posted.id;
      });
    }
    const [updated] = await tx
      .update(schema.workOrders)
      .set({ status: 'verified', verifiedBy: userId, verifiedAt: new Date(), actualCostKobo: cost, expenseJournalId: journalId, version: row.version + 1 })
      .where(and(eq(schema.workOrders.id, id), eq(schema.workOrders.version, row.version)))
      .returning();
    if (!updated) throw versionConflict();
    await recordAudit(tx, identity, {
      action: 'work_order.verified',
      entityType: 'work_order',
      entityId: id,
      organizationId: row.organizationId,
      before: { status: row.status },
      after: { status: 'verified', costKobo: cost, journalId },
      correlationId: options.correlationId,
    });
    await emitTransition(tx, identity, updated, row.status, 'verified', options);
    return one(tx, updated);
  });
}

export function closeWorkOrder(identity: RequestIdentity, id: string, input: { expectedVersion: number }, options: ServiceOptions = {}) {
  return transition(identity, id, { to: 'closed', expectedVersion: input.expectedVersion, allow: ['staff'] }, options);
}

/* ---------------------------------------------------------------------- */
/* Reads                                                                   */
/* ---------------------------------------------------------------------- */

export async function getWorkOrder(identity: RequestIdentity, id: string): Promise<WorkOrderDto> {
  return withActor(getDb(), identity.ctx, async (tx) => one(tx, (await requireWorkOrder(tx, identity, id)).row));
}

/**
 * Lists work orders the caller may see. Staff filter by organisation;
 * customers are scoped to their organisation; tenants and partners only ever
 * receive rows they reported, are a lease party of, or are assigned to
 * (row-level security guarantees it; the filter here makes it explicit).
 */
export async function listWorkOrders(identity: RequestIdentity, query: WorkOrderListQuery): Promise<Page<WorkOrderDto>> {
  const userId = requireUserId(identity);
  const staff = isStaffIdentity(identity);
  const orgId = staff ? (query.organizationId ?? null) : identity.ctx.organizationId;
  if (query.estateId && !isFeatureEnabled(identity, FEATURES.estateManagement))
    throw new ApiError('feature_disabled', 'estate issues need estate management', { details: { feature: FEATURES.estateManagement } });
  const cursor = decodeCursor(query.cursor);
  const now = new Date();
  return withActor(getDb(), identity.ctx, async (tx) => {
    const memberScope = !staff && orgId ? eq(schema.workOrders.organizationId, orgId) : undefined;
    const personalScope = !staff
      ? or(eq(schema.workOrders.reportedByUserId, userId), eq(schema.workOrders.assigneeUserId, userId), sql`${schema.workOrders.leaseId} IN (SELECT lease_id FROM lease_parties WHERE user_id = ${userId} AND access_status = 'active')`)
      : undefined;
    const rows = await tx
      .select()
      .from(schema.workOrders)
      .where(
        and(
          staff && orgId ? eq(schema.workOrders.organizationId, orgId) : undefined,
          !staff ? (memberScope && identity.actor.memberships.some((m) => m.organizationId === orgId) ? or(memberScope, personalScope) : personalScope) : undefined,
          query.propertyId ? eq(schema.workOrders.propertyId, query.propertyId) : undefined,
          query.leaseId ? eq(schema.workOrders.leaseId, query.leaseId) : undefined,
          query.estateId ? eq(schema.workOrders.estateId, query.estateId) : undefined,
          query.status ? eq(schema.workOrders.status, query.status) : undefined,
          query.breachedOnly ? and(lt(schema.workOrders.slaDueAt, now), inArray(schema.workOrders.status, ['requested', 'triaged', 'assigned', 'in_progress', 'awaiting_approval', 'approved'])) : undefined,
          cursor ? or(lt(schema.workOrders.createdAt, cursor.createdAt), and(eq(schema.workOrders.createdAt, cursor.createdAt), lt(schema.workOrders.id, cursor.id))) : undefined,
        ),
      )
      .orderBy(desc(schema.workOrders.createdAt), desc(schema.workOrders.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = rows.length > query.limit ? page[page.length - 1] : null;
    return { items: await toDtos(tx, page, now), nextCursor: last ? encodeCursor(last.createdAt, last.id) : null };
  });
}

/* ---------------------------------------------------------------------- */
/* Jobs                                                                    */
/* ---------------------------------------------------------------------- */

/** Flags open work orders past their SLA once (audit + outbox), for the SLA queue and reporting. */
export async function checkSlaBreaches(db: Database, now: Date = new Date()): Promise<number> {
  return withActor(db, systemContext('work_orders.sla_check'), async (tx) => {
    const rows = await tx
      .select()
      .from(schema.workOrders)
      .where(and(lt(schema.workOrders.slaDueAt, now), inArray(schema.workOrders.status, ['requested', 'triaged', 'assigned', 'in_progress', 'awaiting_approval', 'approved'])));
    let flagged = 0;
    for (const row of rows) {
      const [already] = await tx
        .select({ id: schema.auditEvents.id })
        .from(schema.auditEvents)
        .where(and(eq(schema.auditEvents.entityType, 'work_order'), eq(schema.auditEvents.entityId, row.id), eq(schema.auditEvents.action, 'work_order.sla_breached')))
        .limit(1);
      if (already) continue;
      await recordAudit(tx, null, {
        action: 'work_order.sla_breached',
        entityType: 'work_order',
        entityId: row.id,
        organizationId: row.organizationId,
        after: { status: row.status, slaDueAt: row.slaDueAt, priority: row.priority },
        actorType: 'job',
      });
      await appendOutbox(tx, {
        eventType: 'work_order.sla_breached',
        aggregateType: 'work_order',
        aggregateId: row.id,
        organizationId: row.organizationId,
        actorUserId: null,
        payload: { workOrderId: row.id, status: row.status, priority: row.priority, slaDueAt: row.slaDueAt?.toISOString() ?? null, assigneeUserId: row.assigneeUserId },
        correlationId: null,
      });
      flagged += 1;
    }
    return flagged;
  });
}

/**
 * Preventive maintenance: assets whose next service date has arrived get a
 * recurring work order (one open at a time per asset) and their next
 * service date advances by the interval. Only when the flag is enabled.
 */
export async function generateRecurringWorkOrders(db: Database, asOf: string = today()): Promise<number> {
  return withActor(db, systemContext('work_orders.recurring'), async (tx) => {
    const [flag] = await tx.select({ enabled: schema.featureFlags.enabled }).from(schema.featureFlags).where(eq(schema.featureFlags.key, FEATURES.preventiveMaintenance));
    if (!flag?.enabled) return 0;
    const due = await tx
      .select()
      .from(schema.assets)
      .where(and(sql`${schema.assets.nextServiceAt} <= ${asOf}`, sql`${schema.assets.serviceIntervalDays} IS NOT NULL`));
    let created = 0;
    for (const asset of due) {
      const [open] = await tx
        .select({ id: schema.workOrders.id })
        .from(schema.workOrders)
        .where(and(eq(schema.workOrders.assetId, asset.id), inArray(schema.workOrders.status, ['requested', 'triaged', 'assigned', 'in_progress', 'awaiting_approval', 'approved'])))
        .limit(1);
      if (!open) {
        const now = new Date();
        const [row] = await tx
          .insert(schema.workOrders)
          .values({
            organizationId: asset.organizationId,
            propertyId: asset.propertyId,
            assetId: asset.id,
            estateId: asset.estateId,
            title: `Scheduled service: ${asset.name}`,
            description: `Recurring service every ${asset.serviceIntervalDays} days (due ${asset.nextServiceAt}).`,
            category: 'preventive',
            priority: 'normal',
            status: 'requested',
            slaDueAt: slaDueAt('normal', now),
            recurring: { assetId: asset.id, intervalDays: asset.serviceIntervalDays, dueOn: asset.nextServiceAt },
          })
          .returning();
        await recordAudit(tx, null, { action: 'work_order.requested', entityType: 'work_order', entityId: row!.id, organizationId: asset.organizationId, after: { assetId: asset.id, recurring: true }, actorType: 'job' });
        await emitTransition(tx, null, row!, null, 'requested', {});
        created += 1;
      }
      await tx.update(schema.assets).set({ nextServiceAt: nextServiceDate(asOf, asset.serviceIntervalDays) }).where(eq(schema.assets.id, asset.id));
    }
    return created;
  });
}
