import 'server-only';
import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import type { AssignmentStatus } from '@simplexd/contracts';
import { schema, type DbExecutor } from '@simplexd/db';
import {
  authorizeAny,
  authorizeStaff,
  membershipFor,
  type ResourceRef,
  type StaffPermission,
} from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';
import { uniqueIds } from './shared';

/**
 * Assignment-derived access. Partners (and staff without a broad role) reach
 * a service request or project only through an accepted or active
 * assignment, which is exactly what the row-level security helpers
 * `app.can_access_service_request` / `app.can_access_project` check. Other
 * modules build their `ResourceRef`s from `loadAssignmentContext` so the
 * application policy and the database agree.
 */

/** Statuses that grant access to the linked service request or project. */
export const ACCESS_GRANTING_ASSIGNMENT_STATUSES: readonly AssignmentStatus[] = [
  'accepted',
  'active',
];

/** Statuses that count as open work (still visible in "my assignments"). */
export const OPEN_ASSIGNMENT_STATUSES: readonly AssignmentStatus[] = [
  'proposed',
  'accepted',
  'active',
];

export interface AssignmentContext {
  /** Users assigned (via the given statuses) to the project and/or service request. */
  assigneeUserIds: string[];
  /** Projects the user is assigned to. */
  assignedProjectIds: string[];
  /** Service requests the user is assigned to. */
  assignedServiceRequestIds: string[];
}

export interface AssignmentContextInput {
  userId: string;
  projectId?: string | null;
  serviceRequestId?: string | null;
  /** Defaults to proposed, accepted and active. Pass ACCESS_GRANTING_ASSIGNMENT_STATUSES for access decisions. */
  statuses?: readonly AssignmentStatus[];
}

/**
 * Loads the assignment relationships needed to build a `ResourceRef`. Runs
 * under the caller's row-level security context, so a partner only ever sees
 * their own assignment rows and a customer only their organisation's.
 */
export async function loadAssignmentContext(
  tx: DbExecutor,
  input: AssignmentContextInput,
): Promise<AssignmentContext> {
  const statuses = [...(input.statuses ?? OPEN_ASSIGNMENT_STATUSES)];
  const targets = [
    input.serviceRequestId ? eq(schema.assignments.serviceRequestId, input.serviceRequestId) : null,
    input.projectId ? eq(schema.assignments.projectId, input.projectId) : null,
  ].filter((c): c is NonNullable<typeof c> => c !== null);

  const assigneeRows =
    targets.length === 0
      ? []
      : await tx
          .select({ assigneeUserId: schema.assignments.assigneeUserId })
          .from(schema.assignments)
          .where(and(inArray(schema.assignments.status, statuses), or(...targets)));

  const own = await tx
    .select({
      projectId: schema.assignments.projectId,
      serviceRequestId: schema.assignments.serviceRequestId,
    })
    .from(schema.assignments)
    .where(
      and(
        eq(schema.assignments.assigneeUserId, input.userId),
        inArray(schema.assignments.status, statuses),
        or(isNotNull(schema.assignments.projectId), isNotNull(schema.assignments.serviceRequestId)),
      ),
    );

  return {
    assigneeUserIds: uniqueIds(assigneeRows.map((r) => r.assigneeUserId)),
    assignedProjectIds: uniqueIds(own.map((r) => r.projectId)),
    assignedServiceRequestIds: uniqueIds(own.map((r) => r.serviceRequestId)),
  };
}

/* ---------------------------------------------------------------------- */
/* Entity resolution for notes, tasks and conversations                    */
/* ---------------------------------------------------------------------- */

export type CollaborationEntityType =
  | 'service_request'
  | 'project'
  | 'property'
  | 'lead'
  | 'site_visit'
  | 'report'
  | 'defect'
  // Commercial entities partners work on: assignees are the invited or named partners.
  | 'tender'
  | 'purchase_order'
  | 'rfq';

export interface EntityAccess {
  type: CollaborationEntityType;
  id: string;
  organizationId: string | null;
  createdBy: string | null;
  /** Staff attached directly (PM, inspector, reviewer) plus accepted/active assignees. */
  assigneeUserIds: string[];
  serviceRequestId: string | null;
  projectId: string | null;
}

/** Staff permissions that allow reading (and commenting on) an entity. */
export const ENTITY_STAFF_READ: Record<CollaborationEntityType, StaffPermission[]> = {
  service_request: ['service_requests.read_all'],
  project: ['projects.read_all'],
  property: ['customers.read', 'projects.read_all'],
  lead: ['leads.read'],
  site_visit: ['projects.read_all', 'site_visits.perform'],
  report: ['projects.read_all', 'reports.review', 'reports.release', 'reports.draft'],
  defect: ['projects.read_all', 'site_visits.perform'],
  tender: ['tenders.manage', 'bids.evaluate', 'projects.read_all'],
  purchase_order: ['procurement.manage', 'projects.read_all'],
  rfq: ['procurement.manage', 'projects.read_all'],
};

/** Staff permissions that allow managing work (tasks, assignments) on an entity. */
export const ENTITY_STAFF_MANAGE: Record<CollaborationEntityType, StaffPermission[]> = {
  service_request: ['service_requests.assign', 'projects.manage'],
  project: ['projects.manage', 'service_requests.assign'],
  property: ['customers.manage', 'projects.manage'],
  lead: ['leads.manage'],
  site_visit: ['projects.manage', 'site_visits.perform'],
  report: ['projects.manage', 'reports.review'],
  defect: ['projects.manage', 'site_visits.perform'],
  tender: ['tenders.manage'],
  purchase_order: ['procurement.manage'],
  rfq: ['procurement.manage'],
};

/**
 * Loads the parent entity under the caller's row-level security context and
 * returns the relationships needed for authorisation, or null when the row is
 * not visible to the caller (which callers report as `not_found`).
 */
export async function resolveEntity(
  tx: DbExecutor,
  type: CollaborationEntityType,
  id: string,
): Promise<EntityAccess | null> {
  const base = await loadEntityRow(tx, type, id);
  if (!base) return null;
  const direct = base.assigneeUserIds;
  if (base.serviceRequestId || base.projectId) {
    const assignees = await tx
      .select({ assigneeUserId: schema.assignments.assigneeUserId })
      .from(schema.assignments)
      .where(
        and(
          inArray(schema.assignments.status, [...ACCESS_GRANTING_ASSIGNMENT_STATUSES]),
          or(
            base.serviceRequestId
              ? eq(schema.assignments.serviceRequestId, base.serviceRequestId)
              : undefined,
            base.projectId ? eq(schema.assignments.projectId, base.projectId) : undefined,
          ),
        ),
      );
    direct.push(...assignees.map((a) => a.assigneeUserId));
  }
  return { ...base, assigneeUserIds: uniqueIds(direct) };
}

async function loadEntityRow(
  tx: DbExecutor,
  type: CollaborationEntityType,
  id: string,
): Promise<EntityAccess | null> {
  switch (type) {
    case 'service_request': {
      const [row] = await tx
        .select({
          id: schema.serviceRequests.id,
          organizationId: schema.serviceRequests.organizationId,
          pm: schema.serviceRequests.assignedPmUserId,
          requestedBy: schema.serviceRequests.requestedByUserId,
          projectId: schema.serviceRequests.projectId,
        })
        .from(schema.serviceRequests)
        .where(eq(schema.serviceRequests.id, id));
      if (!row) return null;
      return {
        type,
        id: row.id,
        organizationId: row.organizationId,
        createdBy: row.requestedBy,
        assigneeUserIds: uniqueIds([row.pm]),
        serviceRequestId: row.id,
        projectId: row.projectId,
      };
    }
    case 'project': {
      const [row] = await tx
        .select({
          id: schema.projects.id,
          organizationId: schema.projects.organizationId,
          pm: schema.projects.pmUserId,
          createdBy: schema.projects.createdBy,
          serviceRequestId: schema.projects.serviceRequestId,
        })
        .from(schema.projects)
        .where(eq(schema.projects.id, id));
      if (!row) return null;
      return {
        type,
        id: row.id,
        organizationId: row.organizationId,
        createdBy: row.createdBy,
        assigneeUserIds: uniqueIds([row.pm]),
        serviceRequestId: row.serviceRequestId,
        projectId: row.id,
      };
    }
    case 'property': {
      const [row] = await tx
        .select({
          id: schema.properties.id,
          organizationId: schema.properties.organizationId,
          createdBy: schema.properties.createdBy,
        })
        .from(schema.properties)
        .where(eq(schema.properties.id, id));
      if (!row) return null;
      return {
        type,
        id: row.id,
        organizationId: row.organizationId,
        createdBy: row.createdBy,
        assigneeUserIds: [],
        serviceRequestId: null,
        projectId: null,
      };
    }
    case 'lead': {
      const [row] = await tx
        .select({
          id: schema.leads.id,
          organizationId: schema.leads.organizationId,
          userId: schema.leads.userId,
          assignedTo: schema.leads.assignedToUserId,
        })
        .from(schema.leads)
        .where(eq(schema.leads.id, id));
      if (!row) return null;
      return {
        type,
        id: row.id,
        organizationId: row.organizationId,
        createdBy: row.userId,
        assigneeUserIds: uniqueIds([row.assignedTo]),
        serviceRequestId: null,
        projectId: null,
      };
    }
    case 'site_visit': {
      const [row] = await tx
        .select({
          id: schema.siteVisits.id,
          organizationId: schema.siteVisits.organizationId,
          inspector: schema.siteVisits.inspectorUserId,
          reviewedBy: schema.siteVisits.reviewedBy,
          projectId: schema.siteVisits.projectId,
          serviceRequestId: schema.siteVisits.serviceRequestId,
        })
        .from(schema.siteVisits)
        .where(eq(schema.siteVisits.id, id));
      if (!row) return null;
      return {
        type,
        id: row.id,
        organizationId: row.organizationId,
        createdBy: row.inspector,
        assigneeUserIds: uniqueIds([row.inspector, row.reviewedBy]),
        serviceRequestId: row.serviceRequestId,
        projectId: row.projectId,
      };
    }
    case 'report': {
      const [row] = await tx
        .select({
          id: schema.reports.id,
          organizationId: schema.reports.organizationId,
          createdBy: schema.reports.createdBy,
          reviewer: schema.reports.namedReviewerUserId,
          projectId: schema.reports.projectId,
          serviceRequestId: schema.reports.serviceRequestId,
        })
        .from(schema.reports)
        .where(eq(schema.reports.id, id));
      if (!row) return null;
      return {
        type,
        id: row.id,
        organizationId: row.organizationId,
        createdBy: row.createdBy,
        assigneeUserIds: uniqueIds([row.createdBy, row.reviewer]),
        serviceRequestId: row.serviceRequestId,
        projectId: row.projectId,
      };
    }
    case 'defect': {
      const [row] = await tx
        .select({
          id: schema.defects.id,
          organizationId: schema.defects.organizationId,
          createdBy: schema.defects.createdBy,
          verifiedBy: schema.defects.verifiedBy,
          projectId: schema.defects.projectId,
        })
        .from(schema.defects)
        .where(eq(schema.defects.id, id));
      if (!row) return null;
      return {
        type,
        id: row.id,
        organizationId: row.organizationId,
        createdBy: row.createdBy,
        assigneeUserIds: uniqueIds([row.createdBy, row.verifiedBy]),
        serviceRequestId: null,
        projectId: row.projectId,
      };
    }
    case 'tender': {
      // Invited partners are the tender's assignees (a partner sees only their own invitation row).
      const [row] = await tx
        .select({
          id: schema.tenders.id,
          organizationId: schema.tenders.organizationId,
          createdBy: schema.tenders.createdBy,
          projectId: schema.tenders.projectId,
          serviceRequestId: schema.tenders.serviceRequestId,
        })
        .from(schema.tenders)
        .where(eq(schema.tenders.id, id));
      if (!row) return null;
      const invited = await tx
        .select({ partnerUserId: schema.tenderInvitations.partnerUserId })
        .from(schema.tenderInvitations)
        .where(eq(schema.tenderInvitations.tenderId, id));
      return {
        type,
        id: row.id,
        organizationId: row.organizationId,
        createdBy: row.createdBy,
        assigneeUserIds: uniqueIds([row.createdBy, ...invited.map((i) => i.partnerUserId)]),
        serviceRequestId: row.serviceRequestId,
        projectId: row.projectId,
      };
    }
    case 'purchase_order': {
      const [row] = await tx
        .select({
          id: schema.purchaseOrders.id,
          organizationId: schema.purchaseOrders.organizationId,
          createdBy: schema.purchaseOrders.createdBy,
          supplierUserId: schema.purchaseOrders.supplierUserId,
          projectId: schema.purchaseOrders.projectId,
          status: schema.purchaseOrders.status,
        })
        .from(schema.purchaseOrders)
        .where(eq(schema.purchaseOrders.id, id));
      if (!row) return null;
      return {
        type,
        id: row.id,
        organizationId: row.organizationId,
        createdBy: row.createdBy,
        // A supplier learns about an order only once it is issued.
        assigneeUserIds: uniqueIds([row.createdBy, row.status === 'draft' ? null : row.supplierUserId]),
        serviceRequestId: null,
        projectId: row.projectId,
      };
    }
    case 'rfq': {
      const [row] = await tx
        .select({
          id: schema.rfqs.id,
          organizationId: schema.rfqs.organizationId,
          createdBy: schema.rfqs.createdBy,
          projectId: schema.rfqs.projectId,
        })
        .from(schema.rfqs)
        .where(eq(schema.rfqs.id, id));
      if (!row) return null;
      const responses = await tx
        .select({ supplierUserId: schema.rfqResponses.supplierUserId })
        .from(schema.rfqResponses)
        .where(eq(schema.rfqResponses.rfqId, id));
      return {
        type,
        id: row.id,
        organizationId: row.organizationId,
        createdBy: row.createdBy,
        assigneeUserIds: uniqueIds([row.createdBy, ...responses.map((r) => r.supplierUserId)]),
        serviceRequestId: null,
        projectId: row.projectId,
      };
    }
  }
}

/** `ResourceRef` for the domain policy, including the caller's own assignment relationships. */
export async function entityResourceRef(
  tx: DbExecutor,
  identity: RequestIdentity,
  entity: EntityAccess,
): Promise<ResourceRef> {
  const userId = identity.session?.user.id;
  const own = userId
    ? await loadAssignmentContext(tx, {
        userId,
        statuses: ACCESS_GRANTING_ASSIGNMENT_STATUSES,
      })
    : { assigneeUserIds: [], assignedProjectIds: [], assignedServiceRequestIds: [] };
  return {
    type: entity.type,
    id: entity.id,
    organizationId: entity.organizationId,
    createdBy: entity.createdBy,
    assigneeUserIds: entity.assigneeUserIds,
    assignedProjectIds: [...own.assignedProjectIds, ...own.assignedServiceRequestIds],
  };
}

/**
 * How the caller relates to an entity:
 * - `staff`: holds one of the staff permissions for the entity (project managers
 *   and inspectors still have to be attached to it);
 * - `assignee`: reaches the entity only through an accepted/active assignment
 *   (partners, or staff without a broad role);
 * - `customer`: a member of the owning organisation;
 * - null: no relationship (callers respond with `not_found` or `forbidden`).
 */
export type ViewerClass = 'staff' | 'assignee' | 'customer';

export function classifyViewer(
  identity: RequestIdentity,
  entity: EntityAccess,
  ref: ResourceRef,
  staffPermissions: StaffPermission[],
): ViewerClass | null {
  const userId = identity.session?.user.id;
  if (!userId) return null;
  if (identity.actor.staffRoles.length > 0) {
    const decision = authorizeAny(
      identity.actor,
      staffPermissions.map((staff) => ({ staff })),
      ref,
    );
    if (decision.allowed) return 'staff';
  }
  if (entity.assigneeUserIds.includes(userId)) return 'assignee';
  if (entity.organizationId && membershipFor(identity.actor, entity.organizationId)) {
    const decision = authorizeAny(identity.actor, [{ org: 'org.read' }], ref);
    if (decision.allowed) return 'customer';
  }
  return null;
}

export function staffAllowed(
  identity: RequestIdentity,
  permissions: StaffPermission[],
  ref?: ResourceRef,
): boolean {
  if (identity.actor.staffRoles.length === 0) return false;
  return permissions.some((p) => authorizeStaff(identity.actor, p, ref).allowed);
}
