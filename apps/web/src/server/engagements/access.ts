import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Transaction } from '@simplexd/db';
import {
  AuthorizationError,
  authorizeOrg,
  authorizePartner,
  authorizeStaff,
  type Decision,
  type ResourceRef,
} from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';
import type { AccessCheck } from '@/server/projects/access';
import { notFound, userIdOf } from '@/server/projects/shared';

/**
 * Service-request-level access for engagement records and for reports that
 * are written under a service request rather than a project.
 *
 * The request is loaded under the caller's row-level security context, so a
 * customer of another organisation, or a partner without an accepted/active
 * assignment, gets "not found". The application policy is then applied with
 * the same `AccessCheck` shape the project services use:
 * - staff checks run against a `service_request` resource whose assignees
 *   are the request's project manager plus its live assignments (so a
 *   project manager only reaches requests they are attached to);
 * - organisation checks run against the request's organisation;
 * - partner checks need an accepted/active assignment on the request.
 */

export type ServiceRequestRow = typeof schema.serviceRequests.$inferSelect;

export interface ServiceRequestAccess {
  sr: ServiceRequestRow;
  /** Project manager plus users with a proposed/accepted/active assignment. */
  staffAssigneeIds: string[];
  /** Users with an accepted/active assignment (the partner relationship rule). */
  partnerAssigneeIds: string[];
}

export interface RequestRefOverrides {
  createdBy?: string | null;
  /** Extra users that count as attached for this check (e.g. a report's named reviewer). */
  extraAssigneeIds?: Array<string | null | undefined>;
}

/** Permissions that let someone read a service request's engagement records at all. */
export const REQUEST_READ_CHECKS: AccessCheck[] = [
  { staff: 'service_requests.read_all' },
  { staff: 'reports.review' },
  { staff: 'reports.release' },
  { staff: 'site_visits.perform' },
  { org: 'org.read' },
  { partner: 'partner.assignments.view' },
];

/** Staff who manage the request's engagement records (items, assignments of items). */
export const REQUEST_MANAGE_CHECKS: AccessCheck[] = [
  { staff: 'service_requests.triage' },
  { staff: 'projects.manage' },
];

export async function loadServiceRequestAccess(
  tx: Transaction,
  serviceRequestId: string,
): Promise<ServiceRequestAccess | null> {
  const [sr] = await tx
    .select()
    .from(schema.serviceRequests)
    .where(eq(schema.serviceRequests.id, serviceRequestId));
  if (!sr) return null;
  const rows = await tx
    .select({
      assigneeUserId: schema.assignments.assigneeUserId,
      status: schema.assignments.status,
    })
    .from(schema.assignments)
    .where(
      and(
        eq(schema.assignments.serviceRequestId, serviceRequestId),
        inArray(schema.assignments.status, ['proposed', 'accepted', 'active']),
      ),
    );
  const staff = new Set(rows.map((r) => r.assigneeUserId));
  if (sr.assignedPmUserId) staff.add(sr.assignedPmUserId);
  return {
    sr,
    staffAssigneeIds: [...staff],
    partnerAssigneeIds: rows
      .filter((r) => r.status === 'accepted' || r.status === 'active')
      .map((r) => r.assigneeUserId),
  };
}

function uniq(ids: Array<string | null | undefined>): string[] {
  return [...new Set(ids.filter((v): v is string => Boolean(v)))];
}

export function requestRef(
  access: ServiceRequestAccess,
  overrides: RequestRefOverrides = {},
): ResourceRef {
  return {
    type: 'service_request',
    id: access.sr.id,
    organizationId: access.sr.organizationId,
    createdBy: overrides.createdBy ?? null,
    assigneeUserIds: uniq([...access.staffAssigneeIds, ...(overrides.extraAssigneeIds ?? [])]),
  };
}

function partnerRequestRef(
  access: ServiceRequestAccess,
  overrides: RequestRefOverrides = {},
): ResourceRef {
  return {
    type: 'service_request',
    id: access.sr.id,
    organizationId: access.sr.organizationId,
    assigneeUserIds: uniq(access.partnerAssigneeIds),
    createdBy: overrides.createdBy ?? null,
  };
}

/** First allowed decision wins; the denial reported is the one from the caller's own kind. */
export function decideRequestAccess(
  identity: RequestIdentity,
  access: ServiceRequestAccess,
  checks: AccessCheck[],
  overrides: RequestRefOverrides = {},
): Decision {
  const actor = identity.actor;
  const ref = requestRef(access, overrides);
  const pRef = partnerRequestRef(access, overrides);
  const kind: 'staff' | 'org' | 'partner' =
    actor.staffRoles.length > 0 ? 'staff' : actor.memberships.length > 0 ? 'org' : 'partner';
  let own: Decision | null = null;
  let last: Decision = {
    allowed: false,
    code: 'no_permission',
    reason: 'no applicable permission',
  };
  const consider = (d: Decision, k: typeof kind) => {
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

export function allowsRequest(
  identity: RequestIdentity,
  access: ServiceRequestAccess,
  checks: AccessCheck[],
  overrides: RequestRefOverrides = {},
): boolean {
  return decideRequestAccess(identity, access, checks, overrides).allowed;
}

/** Loads the request (row-level security applies) and enforces the checks. */
export async function requireServiceRequest(
  tx: Transaction,
  identity: RequestIdentity,
  serviceRequestId: string,
  checks: AccessCheck[],
  overrides: RequestRefOverrides = {},
): Promise<ServiceRequestAccess> {
  userIdOf(identity);
  const access = await loadServiceRequestAccess(tx, serviceRequestId);
  if (!access) throw notFound('service request');
  const decision = decideRequestAccess(identity, access, checks, overrides);
  if (!decision.allowed) throw new AuthorizationError(decision);
  return access;
}

/** Organisation-side user (not staff) of the request's organisation. */
export function isRequestCustomer(
  identity: RequestIdentity,
  access: ServiceRequestAccess,
): boolean {
  return (
    identity.actor.staffRoles.length === 0 &&
    identity.actor.memberships.some((m) => m.organizationId === access.sr.organizationId)
  );
}

/** Partner (non-staff) reaching the request through an accepted/active assignment. */
export function isRequestPartner(identity: RequestIdentity, access: ServiceRequestAccess): boolean {
  const userId = identity.session?.user.id;
  return (
    identity.actor.staffRoles.length === 0 &&
    identity.actor.isPartner &&
    Boolean(userId && access.partnerAssigneeIds.includes(userId))
  );
}
