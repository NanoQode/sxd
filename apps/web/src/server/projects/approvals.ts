import 'server-only';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  ApiError,
  type ApprovalDto,
  type ApprovalsQuery,
  type PendingApprovalDto,
  type PendingApprovalsResponse,
} from '@simplexd/contracts';
import { getDb, schema, withActor, type Transaction } from '@simplexd/db';
import { authorizeOrg, hasStaffPermission } from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';
import {
  ACTIVE_ASSIGNMENT_STATUSES,
  PROJECT_READ_CHECKS,
  buildAccess,
  decideProjectAccess,
  requireProject,
} from './access';
import { ctxFor, iso, notFound, userIdOf } from './shared';

export type ApprovalRow = typeof schema.approvals.$inferSelect;

export function toApprovalDto(a: ApprovalRow): ApprovalDto {
  return {
    id: a.id,
    organizationId: a.organizationId,
    entityType: a.entityType,
    entityId: a.entityId,
    approverRole: a.approverRole,
    approverUserId: a.approverUserId,
    status: a.status,
    decisionNote: a.decisionNote,
    requestedBy: a.requestedBy,
    requestedAt: a.requestedAt.toISOString(),
    decidedAt: iso(a.decidedAt),
    expiresAt: iso(a.expiresAt),
  };
}

export async function approvalsForEntity(
  tx: Transaction,
  entityType: string,
  entityId: string,
): Promise<ApprovalRow[]> {
  return tx
    .select()
    .from(schema.approvals)
    .where(and(eq(schema.approvals.entityType, entityType), eq(schema.approvals.entityId, entityId)))
    .orderBy(schema.approvals.requestedAt, schema.approvals.id);
}

interface EntityLocator {
  projectId: string | null;
  title: string | null;
}

async function locateEntity(
  tx: Transaction,
  entityType: string,
  entityId: string,
): Promise<EntityLocator | null> {
  switch (entityType) {
    case 'change_order': {
      const [row] = await tx
        .select({ projectId: schema.changeOrders.projectId, title: schema.changeOrders.title })
        .from(schema.changeOrders)
        .where(eq(schema.changeOrders.id, entityId));
      return row ?? null;
    }
    case 'budget_version': {
      const [row] = await tx
        .select({ projectId: schema.budgetVersions.projectId, version: schema.budgetVersions.version })
        .from(schema.budgetVersions)
        .where(eq(schema.budgetVersions.id, entityId));
      return row ? { projectId: row.projectId, title: `Budget version ${row.version}` } : null;
    }
    case 'milestone': {
      const [row] = await tx
        .select({ projectId: schema.milestones.projectId, title: schema.milestones.name })
        .from(schema.milestones)
        .where(eq(schema.milestones.id, entityId));
      return row ?? null;
    }
    default:
      return null;
  }
}

/** Approval records for one entity; the caller must be able to read the owning project. */
export async function listApprovals(
  identity: RequestIdentity,
  query: ApprovalsQuery,
): Promise<{ items: ApprovalDto[] }> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    const located = await locateEntity(tx, query.entityType, query.entityId);
    if (!located || !located.projectId) throw notFound(query.entityType);
    await requireProject(tx, identity, located.projectId, PROJECT_READ_CHECKS);
    const rows = await approvalsForEntity(tx, query.entityType, query.entityId);
    return { items: rows.map(toApprovalDto) };
  });
}

/**
 * Pending approvals the caller can decide: customer approvers see their
 * organisation's pending customer approvals; staff with change-order or
 * budget authority see staff approvals on projects they may manage.
 * Deciding always goes through the entity-specific endpoints.
 */
export async function listPendingApprovals(
  identity: RequestIdentity,
): Promise<PendingApprovalsResponse> {
  userIdOf(identity);
  const actor = identity.actor;
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    const actingAs: Array<'customer' | 'staff'> = [];
    const items: PendingApprovalDto[] = [];

    if (actor.staffRoles.length > 0) {
      const canDecide =
        hasStaffPermission(actor, 'change_orders.staff_approve') ||
        hasStaffPermission(actor, 'projects.manage');
      if (canDecide) {
        actingAs.push('staff');
        const rows = await tx
          .select()
          .from(schema.approvals)
          .where(and(eq(schema.approvals.status, 'pending'), eq(schema.approvals.approverRole, 'staff')))
          .orderBy(desc(schema.approvals.requestedAt))
          .limit(500);
        items.push(...(await filterByProjectAccess(tx, identity, rows, 'staff')));
      }
    } else {
      const orgId = identity.ctx.organizationId;
      if (orgId) {
        const allowed =
          authorizeOrg(actor, 'org.change_orders.approve', { type: 'project', organizationId: orgId }).allowed ||
          authorizeOrg(actor, 'org.milestones.accept', { type: 'project', organizationId: orgId }).allowed;
        if (allowed) {
          actingAs.push('customer');
          const rows = await tx
            .select()
            .from(schema.approvals)
            .where(
              and(
                eq(schema.approvals.status, 'pending'),
                eq(schema.approvals.approverRole, 'customer'),
                eq(schema.approvals.organizationId, orgId),
              ),
            )
            .orderBy(desc(schema.approvals.requestedAt))
            .limit(500);
          items.push(...(await filterByProjectAccess(tx, identity, rows, 'customer')));
        }
      }
    }
    return { items, actingAs };
  });
}

async function filterByProjectAccess(
  tx: Transaction,
  identity: RequestIdentity,
  rows: ApprovalRow[],
  as: 'staff' | 'customer',
): Promise<PendingApprovalDto[]> {
  if (rows.length === 0) return [];
  const located = new Map<string, EntityLocator>();
  for (const r of rows) {
    const key = `${r.entityType}:${r.entityId}`;
    if (!located.has(key)) {
      const l = await locateEntity(tx, r.entityType, r.entityId);
      if (l) located.set(key, l);
    }
  }
  const projectIds = [...new Set([...located.values()].map((l) => l.projectId).filter((x): x is string => !!x))];
  if (projectIds.length === 0) return [];
  const projects = await tx.select().from(schema.projects).where(inArray(schema.projects.id, projectIds));
  const assignments = await tx
    .select()
    .from(schema.assignments)
    .where(
      and(
        inArray(schema.assignments.projectId, projectIds),
        inArray(schema.assignments.status, [...ACTIVE_ASSIGNMENT_STATUSES]),
      ),
    );
  const accessByProject = new Map(
    projects.map((p) => [
      p.id,
      buildAccess(
        p,
        assignments.filter((a) => a.projectId === p.id),
      ),
    ]),
  );
  const out: PendingApprovalDto[] = [];
  for (const r of rows) {
    const l = located.get(`${r.entityType}:${r.entityId}`);
    if (!l?.projectId) continue;
    const access = accessByProject.get(l.projectId);
    if (!access) continue;
    const decision =
      as === 'staff'
        ? decideProjectAccess(identity, access, [
            { staff: 'change_orders.staff_approve' },
            { staff: 'projects.manage' },
          ])
        : decideProjectAccess(identity, access, [
            { org: 'org.change_orders.approve' },
            { org: 'org.milestones.accept' },
          ]);
    if (!decision.allowed) continue;
    if (as === 'staff' && r.entityType === 'change_order') {
      // The creator of a change order never approves it as staff; hide it from their queue.
      const [co] = await tx
        .select({ createdBy: schema.changeOrders.createdBy })
        .from(schema.changeOrders)
        .where(eq(schema.changeOrders.id, r.entityId));
      if (co?.createdBy === identity.session?.user.id) continue;
    }
    out.push({
      ...toApprovalDto(r),
      projectId: l.projectId,
      projectName: access.project.name,
      entityTitle: l.title,
    });
  }
  return out;
}

/** Guard used by services that record decisions: the row must be pending. */
export function assertPendingApproval(row: ApprovalRow | undefined, role: string): ApprovalRow {
  if (!row) throw new ApiError('invalid_transition', `no ${role} approval is pending for this record`);
  if (row.status !== 'pending') {
    throw new ApiError('invalid_transition', `the ${role} approval was already ${row.status}`);
  }
  return row;
}
