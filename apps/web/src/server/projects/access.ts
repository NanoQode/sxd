import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Transaction } from '@simplexd/db';
import {
  AuthorizationError,
  authorizeOrg,
  authorizePartner,
  authorizeStaff,
  type Decision,
  type OrgPermission,
  type PartnerPermission,
  type ResourceRef,
  type StaffPermission,
} from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';
import { notFound, userIdOf } from './shared';

/**
 * Project-level access resolution. Every service loads the project under the
 * caller's row-level security context (so a customer of another organisation
 * gets "not found"), then applies the application policy:
 *
 * - staff: super_admin/operations_manager reach everything; project managers
 *   and inspectors only projects they are assigned to (an `assignments` row in
 *   proposed/accepted/active, or being the project's pmUserId);
 * - customer organisation users: `authorizeOrg` against the project's organisation;
 * - partners: only with an accepted/active assignment and a partner permission.
 */

export type ProjectRow = typeof schema.projects.$inferSelect;
export type AssignmentRow = typeof schema.assignments.$inferSelect;

export interface ProjectAccess {
  project: ProjectRow;
  /** Assignments in proposed/accepted/active for this project. */
  assignments: AssignmentRow[];
  /** Users that count as assigned for staff relationship rules (assignments + pmUserId). */
  staffAssigneeIds: string[];
  /** Users with an accepted/active assignment (partner relationship rule). */
  partnerAssigneeIds: string[];
}

export const ACTIVE_ASSIGNMENT_STATUSES = ['proposed', 'accepted', 'active'] as const;
export const PARTNER_ASSIGNMENT_STATUSES = ['accepted', 'active'] as const;

export async function loadProjectAccess(
  tx: Transaction,
  projectId: string,
): Promise<ProjectAccess | null> {
  const [project] = await tx
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));
  if (!project) return null;
  const assignments = await tx
    .select()
    .from(schema.assignments)
    .where(
      and(
        eq(schema.assignments.projectId, projectId),
        inArray(schema.assignments.status, [...ACTIVE_ASSIGNMENT_STATUSES]),
      ),
    );
  return buildAccess(project, assignments);
}

export function buildAccess(project: ProjectRow, assignments: AssignmentRow[]): ProjectAccess {
  const staffAssigneeIds = new Set<string>(assignments.map((a) => a.assigneeUserId));
  if (project.pmUserId) staffAssigneeIds.add(project.pmUserId);
  const partnerAssigneeIds = assignments
    .filter((a) => (PARTNER_ASSIGNMENT_STATUSES as readonly string[]).includes(a.status))
    .map((a) => a.assigneeUserId);
  return {
    project,
    assignments,
    staffAssigneeIds: [...staffAssigneeIds],
    partnerAssigneeIds,
  };
}

export type RefOverrides = Partial<Pick<ResourceRef, 'type' | 'createdBy' | 'attributes'>> & {
  /** Extra users that count as assigned for this specific check (e.g. a visit's inspector). */
  extraAssigneeIds?: string[];
};

/** Resource reference for staff and organisation checks. */
export function projectRef(access: ProjectAccess, overrides: RefOverrides = {}): ResourceRef {
  const { extraAssigneeIds = [], ...rest } = overrides;
  const assigneeUserIds = [...new Set([...access.staffAssigneeIds, ...extraAssigneeIds])];
  return {
    type: 'project',
    id: access.project.id,
    organizationId: access.project.organizationId,
    // The policy's project-manager rule accepts either an assignee match or an id in
    // assignedProjectIds; only the assignee list is populated so an unassigned PM is denied.
    assigneeUserIds,
    ...rest,
  };
}

/** Resource reference for partner checks: only accepted/active assignments count. */
export function partnerRef(access: ProjectAccess, overrides: RefOverrides = {}): ResourceRef {
  const { extraAssigneeIds = [], ...rest } = overrides;
  return {
    type: 'project',
    id: access.project.id,
    organizationId: access.project.organizationId,
    assigneeUserIds: [...new Set([...access.partnerAssigneeIds, ...extraAssigneeIds])],
    ...rest,
  };
}

export interface AccessCheck {
  staff?: StaffPermission;
  org?: OrgPermission;
  partner?: PartnerPermission;
}

/** Permissions that let someone read a project at all. */
export const PROJECT_READ_CHECKS: AccessCheck[] = [
  { staff: 'projects.read_all' },
  { staff: 'site_visits.perform' },
  { staff: 'reports.draft' },
  { staff: 'milestones.finance_authorize' },
  { staff: 'reports.review' },
  { org: 'org.read' },
  { partner: 'partner.assignments.view' },
];

/**
 * Evaluates the checks in order; the first allowed decision wins. Staff and
 * organisation checks use the project reference, partner checks the stricter
 * partner reference.
 */
export function decideProjectAccess(
  identity: RequestIdentity,
  access: ProjectAccess,
  checks: AccessCheck[],
  overrides: RefOverrides = {},
): Decision {
  const actor = identity.actor;
  const ref = projectRef(access, overrides);
  const pRef = partnerRef(access, overrides);
  // The denial reported is the one from the caller's own kind of check (staff, customer or partner).
  const kind: 'staff' | 'org' | 'partner' =
    actor.staffRoles.length > 0 ? 'staff' : actor.memberships.length > 0 ? 'org' : 'partner';
  let last: Decision = {
    allowed: false,
    code: 'no_permission',
    reason: 'no applicable permission',
  };
  let own: Decision | null = null;
  const consider = (d: Decision, k: 'staff' | 'org' | 'partner') => {
    last = d;
    if (k === kind && !own) own = d;
  };
  for (const c of checks) {
    if (c.staff) {
      const d = authorizeStaff(actor, c.staff, ref);
      if (d.allowed) return d;
      consider(d, 'staff');
    }
    if (c.org) {
      const d = authorizeOrg(actor, c.org, ref);
      if (d.allowed) return d;
      consider(d, 'org');
    }
    if (c.partner) {
      const d = authorizePartner(actor, c.partner, pRef);
      if (d.allowed) return d;
      consider(d, 'partner');
    }
  }
  return own ?? last;
}

export function assertProjectAccess(
  identity: RequestIdentity,
  access: ProjectAccess,
  checks: AccessCheck[],
  overrides: RefOverrides = {},
): Decision {
  userIdOf(identity);
  const decision = decideProjectAccess(identity, access, checks, overrides);
  if (!decision.allowed) throw new AuthorizationError(decision);
  return decision;
}

/** Loads the project (RLS applies) and enforces the checks; missing rows are "not found". */
export async function requireProject(
  tx: Transaction,
  identity: RequestIdentity,
  projectId: string,
  checks: AccessCheck[],
  overrides: RefOverrides = {},
): Promise<ProjectAccess> {
  const access = await loadProjectAccess(tx, projectId);
  if (!access) throw notFound('project');
  assertProjectAccess(identity, access, checks, overrides);
  return access;
}

/** Whether the caller is an organisation-side user (not staff, not partner) for this project. */
export function isCustomerOf(identity: RequestIdentity, access: ProjectAccess): boolean {
  return (
    identity.actor.staffRoles.length === 0 &&
    identity.actor.memberships.some((m) => m.organizationId === access.project.organizationId)
  );
}

/** Ids of the projects a staff member is assigned to, for list queries. */
export async function assignedProjectIds(tx: Transaction, userId: string): Promise<string[]> {
  const rows = await tx
    .select({ projectId: schema.assignments.projectId })
    .from(schema.assignments)
    .where(
      and(
        eq(schema.assignments.assigneeUserId, userId),
        inArray(schema.assignments.status, [...ACTIVE_ASSIGNMENT_STATUSES]),
      ),
    );
  return [...new Set(rows.map((r) => r.projectId).filter((id): id is string => Boolean(id)))];
}
