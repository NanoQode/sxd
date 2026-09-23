import 'server-only';
import { and, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import {
  ApiError,
  type AssignmentDto,
  type AssignmentListQuery,
  type AssignmentPropose,
  type AssignmentStatus,
  type MyAssignmentsQuery,
  type Page,
} from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor, type DbExecutor } from '@simplexd/db';
import { assertAllowed, authorizeAny, authorizePartner } from '@simplexd/domain/authz';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import {
  ENTITY_STAFF_MANAGE,
  ENTITY_STAFF_READ,
  OPEN_ASSIGNMENT_STATUSES,
  classifyViewer,
  entityResourceRef,
  resolveEntity,
  type CollaborationEntityType,
  type EntityAccess,
} from './access';
import {
  actorContext,
  decodeCursor,
  encodeCursor,
  iso,
  isPartnerIdentity,
  isStaffIdentity,
  requireUserId,
  uniqueIds,
  userNameMap,
  type ServiceOptions,
} from './shared';

type AssignmentRow = typeof schema.assignments.$inferSelect;

/**
 * Assignment lifecycle:
 *   proposed → accepted | declined   (the assignee only)
 *   accepted → active                (staff)
 *   active   → completed             (staff or the assignee)
 *   proposed | accepted | active → revoked (staff, with a reason)
 * Only accepted and active assignments grant access to the linked service
 * request or project, in the application policy and in row-level security
 * alike, so revoking removes access the moment the transaction commits.
 */

function toDto(row: AssignmentRow, names: Map<string, string>): AssignmentDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    serviceRequestId: row.serviceRequestId,
    projectId: row.projectId,
    assigneeUserId: row.assigneeUserId,
    assigneeName: names.get(row.assigneeUserId) ?? null,
    role: row.role,
    status: row.status,
    instructions: row.instructions,
    startsAt: iso(row.startsAt),
    endsAt: iso(row.endsAt),
    assignedBy: row.assignedBy,
    respondedAt: iso(row.respondedAt),
    revokedAt: iso(row.revokedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function toDtos(tx: DbExecutor, rows: AssignmentRow[]): Promise<AssignmentDto[]> {
  const names = await userNameMap(
    tx,
    rows.map((r) => r.assigneeUserId),
  );
  return rows.map((r) => toDto(r, names));
}

async function loadAssignment(tx: DbExecutor, id: string): Promise<AssignmentRow | null> {
  const rows = await tx.select().from(schema.assignments).where(eq(schema.assignments.id, id));
  return rows[0] ?? null;
}

function entityOf(row: AssignmentRow): { type: CollaborationEntityType; id: string } {
  if (row.serviceRequestId) return { type: 'service_request', id: row.serviceRequestId };
  if (row.projectId) return { type: 'project', id: row.projectId };
  throw new ApiError('internal_error', 'assignment is not linked to a service request or project');
}

/** Staff with a manage permission on the linked entity (project managers must be attached to it). */
async function requireStaffManage(
  tx: DbExecutor,
  identity: RequestIdentity,
  entity: EntityAccess,
): Promise<void> {
  const ref = await entityResourceRef(tx, identity, entity);
  assertAllowed(
    authorizeAny(
      identity.actor,
      ENTITY_STAFF_MANAGE[entity.type].map((staff) => ({ staff })),
      ref,
    ),
  );
}

async function assertAssignable(tx: DbExecutor, userId: string): Promise<void> {
  const [u] = await tx.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.id, userId));
  if (!u) {
    throw new ApiError('validation_failed', 'assignee does not exist', {
      details: [{ path: 'assigneeUserId', message: 'unknown user' }],
    });
  }
  const [staff] = await tx
    .select({ id: schema.staffRoles.id })
    .from(schema.staffRoles)
    .where(and(eq(schema.staffRoles.userId, userId), isNull(schema.staffRoles.revokedAt)))
    .limit(1);
  if (staff) return;
  const [partner] = await tx
    .select({ id: schema.partnerProfiles.id })
    .from(schema.partnerProfiles)
    .where(eq(schema.partnerProfiles.userId, userId));
  if (partner) return;
  throw new ApiError('validation_failed', 'assignee must be a staff member or a registered partner', {
    details: [{ path: 'assigneeUserId', message: 'not staff or partner' }],
  });
}

/** Recipients for a response notification: whoever proposed it and the entity's staff contact. */
function responseRecipients(row: AssignmentRow, entity: EntityAccess | null): string[] {
  return uniqueIds([row.assignedBy, ...(entity?.assigneeUserIds ?? [])]).filter(
    (id) => id !== row.assigneeUserId,
  );
}

export async function proposeAssignment(
  identity: RequestIdentity,
  input: AssignmentPropose,
  options: ServiceOptions = {},
): Promise<AssignmentDto> {
  const userId = requireUserId(identity);
  if (!isStaffIdentity(identity)) throw new ApiError('forbidden', 'only staff propose assignments');
  const ctx = actorContext(identity, options);
  const target: { type: CollaborationEntityType; id: string } = input.serviceRequestId
    ? { type: 'service_request', id: input.serviceRequestId }
    : { type: 'project', id: input.projectId! };
  return withActor(getDb(), ctx, async (tx) => {
    const entity = await resolveEntity(tx, target.type, target.id);
    if (!entity) throw new ApiError('not_found', `${target.type.replace('_', ' ')} not found`);
    await requireStaffManage(tx, identity, entity);
    await assertAssignable(tx, input.assigneeUserId);
    const [open] = await tx
      .select({ id: schema.assignments.id, status: schema.assignments.status })
      .from(schema.assignments)
      .where(
        and(
          eq(schema.assignments.assigneeUserId, input.assigneeUserId),
          eq(schema.assignments.role, input.role),
          inArray(schema.assignments.status, [...OPEN_ASSIGNMENT_STATUSES]),
          target.type === 'service_request'
            ? eq(schema.assignments.serviceRequestId, target.id)
            : eq(schema.assignments.projectId, target.id),
        ),
      );
    if (open) {
      throw new ApiError('conflict', `this user already has a ${open.status} ${input.role} assignment here`, {
        details: { assignmentId: open.id },
      });
    }
    const [row] = await tx
      .insert(schema.assignments)
      .values({
        organizationId: entity.organizationId!,
        serviceRequestId: target.type === 'service_request' ? target.id : null,
        projectId: target.type === 'project' ? target.id : null,
        assigneeUserId: input.assigneeUserId,
        role: input.role,
        status: 'proposed',
        instructions: input.instructions ?? null,
        startsAt: input.startsAt ? new Date(input.startsAt) : null,
        endsAt: input.endsAt ? new Date(input.endsAt) : null,
        assignedBy: userId,
      })
      .returning();
    await recordAudit(tx, identity, {
      action: 'assignment.proposed',
      entityType: 'assignment',
      entityId: row!.id,
      organizationId: entity.organizationId,
      after: {
        assigneeUserId: input.assigneeUserId,
        role: input.role,
        serviceRequestId: row!.serviceRequestId,
        projectId: row!.projectId,
      },
      correlationId: options.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'assignment.proposed',
      aggregateType: 'assignment',
      aggregateId: row!.id,
      organizationId: entity.organizationId,
      actorUserId: userId,
      payload: {
        assignmentId: row!.id,
        organizationId: entity.organizationId,
        serviceRequestId: row!.serviceRequestId,
        projectId: row!.projectId,
        role: input.role,
        recipientUserIds: [input.assigneeUserId],
      },
      correlationId: options.correlationId ?? null,
    });
    const [dto] = await toDtos(tx, [row!]);
    return dto!;
  });
}

async function respond(
  identity: RequestIdentity,
  id: string,
  decision: 'accepted' | 'declined',
  reason: string | null,
  options: ServiceOptions,
): Promise<AssignmentDto> {
  const userId = requireUserId(identity);
  const ctx = actorContext(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const row = await loadAssignment(tx, id);
    if (!row) throw new ApiError('not_found', 'assignment not found');
    if (row.assigneeUserId !== userId) {
      throw new ApiError('forbidden', 'only the assignee can respond to an assignment');
    }
    if (isPartnerIdentity(identity) && !isStaffIdentity(identity)) {
      assertAllowed(
        authorizePartner(identity.actor, 'partner.assignments.view', {
          type: 'assignment',
          id: row.id,
          assigneeUserIds: [row.assigneeUserId],
        }),
      );
    } else if (!isStaffIdentity(identity)) {
      throw new ApiError('forbidden', 'only staff or partners hold assignments');
    }
    if (row.status !== 'proposed') {
      throw new ApiError('invalid_transition', `assignment is ${row.status}; only proposed assignments can be answered`);
    }
    const target = entityOf(row);
    const entity = await resolveEntity(tx, target.type, target.id);
    const [updated] = await tx
      .update(schema.assignments)
      .set({ status: decision, respondedAt: new Date() })
      .where(and(eq(schema.assignments.id, id), eq(schema.assignments.status, 'proposed')))
      .returning();
    if (!updated) throw new ApiError('invalid_transition', 'assignment changed while responding');
    await recordAudit(tx, identity, {
      action: `assignment.${decision}`,
      entityType: 'assignment',
      entityId: id,
      organizationId: row.organizationId,
      before: { status: 'proposed' },
      after: { status: decision },
      reason,
      correlationId: options.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'assignment.responded',
      aggregateType: 'assignment',
      aggregateId: id,
      organizationId: row.organizationId,
      actorUserId: userId,
      payload: {
        assignmentId: id,
        organizationId: row.organizationId,
        serviceRequestId: row.serviceRequestId,
        projectId: row.projectId,
        decision,
        recipientUserIds: responseRecipients(row, entity),
      },
      correlationId: options.correlationId ?? null,
    });
    const [dto] = await toDtos(tx, [updated]);
    return dto!;
  });
}

export function acceptAssignment(
  identity: RequestIdentity,
  id: string,
  options: ServiceOptions = {},
): Promise<AssignmentDto> {
  return respond(identity, id, 'accepted', null, options);
}

export function declineAssignment(
  identity: RequestIdentity,
  id: string,
  input: { reason?: string },
  options: ServiceOptions = {},
): Promise<AssignmentDto> {
  return respond(identity, id, 'declined', input.reason ?? null, options);
}

async function staffTransition(
  identity: RequestIdentity,
  id: string,
  from: AssignmentStatus[],
  to: AssignmentStatus,
  reason: string | null,
  options: ServiceOptions,
  allowAssignee = false,
): Promise<AssignmentDto> {
  const userId = requireUserId(identity);
  const ctx = actorContext(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const row = await loadAssignment(tx, id);
    if (!row) throw new ApiError('not_found', 'assignment not found');
    const target = entityOf(row);
    const entity = await resolveEntity(tx, target.type, target.id);
    const isAssignee = allowAssignee && row.assigneeUserId === userId;
    if (!isAssignee) {
      if (!entity) throw new ApiError('not_found', 'assignment not found');
      if (!isStaffIdentity(identity)) throw new ApiError('forbidden', 'only staff manage assignments');
      await requireStaffManage(tx, identity, entity);
    }
    if (!from.includes(row.status)) {
      throw new ApiError('invalid_transition', `assignment is ${row.status}; cannot move to ${to}`, {
        details: { from: row.status, to },
      });
    }
    const [updated] = await tx
      .update(schema.assignments)
      .set({ status: to, ...(to === 'revoked' ? { revokedAt: new Date() } : {}) })
      .where(and(eq(schema.assignments.id, id), inArray(schema.assignments.status, from)))
      .returning();
    if (!updated) throw new ApiError('invalid_transition', 'assignment changed concurrently');
    await recordAudit(tx, identity, {
      action: `assignment.${to}`,
      entityType: 'assignment',
      entityId: id,
      organizationId: row.organizationId,
      before: { status: row.status },
      after: { status: to },
      reason,
      correlationId: options.correlationId,
    });
    const [dto] = await toDtos(tx, [updated]);
    return dto!;
  });
}

export function activateAssignment(
  identity: RequestIdentity,
  id: string,
  options: ServiceOptions = {},
): Promise<AssignmentDto> {
  return staffTransition(identity, id, ['accepted'], 'active', null, options);
}

export function completeAssignment(
  identity: RequestIdentity,
  id: string,
  options: ServiceOptions = {},
): Promise<AssignmentDto> {
  return staffTransition(identity, id, ['active'], 'completed', null, options, true);
}

export function revokeAssignment(
  identity: RequestIdentity,
  id: string,
  input: { reason: string },
  options: ServiceOptions = {},
): Promise<AssignmentDto> {
  return staffTransition(
    identity,
    id,
    ['proposed', 'accepted', 'active'],
    'revoked',
    input.reason,
    options,
  );
}

export async function getAssignment(identity: RequestIdentity, id: string): Promise<AssignmentDto> {
  const userId = requireUserId(identity);
  return withActor(getDb(), identity.ctx, async (tx) => {
    const row = await loadAssignment(tx, id);
    if (!row) throw new ApiError('not_found', 'assignment not found');
    if (row.assigneeUserId !== userId) {
      const target = entityOf(row);
      const entity = await resolveEntity(tx, target.type, target.id);
      if (!entity) throw new ApiError('not_found', 'assignment not found');
      const ref = await entityResourceRef(tx, identity, entity);
      const viewer = classifyViewer(identity, entity, ref, ENTITY_STAFF_READ[entity.type]);
      if (viewer !== 'staff' && viewer !== 'customer') {
        throw new ApiError('not_found', 'assignment not found');
      }
      if (viewer === 'customer' && !CUSTOMER_VISIBLE_STATUSES.includes(row.status)) {
        throw new ApiError('not_found', 'assignment not found');
      }
    }
    const [dto] = await toDtos(tx, [row]);
    return dto!;
  });
}

/** Customers see who is working for them, not the staffing churn behind it. */
const CUSTOMER_VISIBLE_STATUSES: AssignmentStatus[] = ['accepted', 'active', 'completed'];

function cursorClause(cursor: { createdAt: Date; id: string } | null) {
  return cursor
    ? or(
        lt(schema.assignments.createdAt, cursor.createdAt),
        and(eq(schema.assignments.createdAt, cursor.createdAt), lt(schema.assignments.id, cursor.id)),
      )
    : undefined;
}

/** Assignments on one service request or project. */
export async function listAssignments(
  identity: RequestIdentity,
  query: AssignmentListQuery,
): Promise<Page<AssignmentDto>> {
  const userId = requireUserId(identity);
  const target: { type: CollaborationEntityType; id: string } = query.serviceRequestId
    ? { type: 'service_request', id: query.serviceRequestId }
    : { type: 'project', id: query.projectId! };
  return withActor(getDb(), identity.ctx, async (tx) => {
    const entity = await resolveEntity(tx, target.type, target.id);
    if (!entity) throw new ApiError('not_found', `${target.type.replace('_', ' ')} not found`);
    const ref = await entityResourceRef(tx, identity, entity);
    const viewer = classifyViewer(identity, entity, ref, ENTITY_STAFF_READ[entity.type]);
    if (!viewer) throw new ApiError('forbidden', 'you do not have access to this resource');
    const cursor = decodeCursor(query.cursor);
    const rows = await tx
      .select()
      .from(schema.assignments)
      .where(
        and(
          target.type === 'service_request'
            ? eq(schema.assignments.serviceRequestId, target.id)
            : eq(schema.assignments.projectId, target.id),
          query.status ? eq(schema.assignments.status, query.status) : undefined,
          viewer === 'customer'
            ? inArray(schema.assignments.status, CUSTOMER_VISIBLE_STATUSES)
            : undefined,
          viewer === 'assignee' ? eq(schema.assignments.assigneeUserId, userId) : undefined,
          cursorClause(cursor),
        ),
      )
      .orderBy(desc(schema.assignments.createdAt), desc(schema.assignments.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = rows.length > query.limit ? page[page.length - 1] : null;
    return {
      items: await toDtos(tx, page),
      nextCursor: last ? encodeCursor(last.createdAt, last.id) : null,
    };
  });
}

/** The signed-in partner's or staff member's own assignments. */
export async function listMyAssignments(
  identity: RequestIdentity,
  query: MyAssignmentsQuery,
): Promise<Page<AssignmentDto>> {
  const userId = requireUserId(identity);
  if (isPartnerIdentity(identity) && !isStaffIdentity(identity)) {
    assertAllowed(
      authorizePartner(identity.actor, 'partner.assignments.view', {
        type: 'assignment',
        assigneeUserIds: [userId],
      }),
    );
  }
  const cursor = decodeCursor(query.cursor);
  return withActor(getDb(), identity.ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.assignments)
      .where(
        and(
          eq(schema.assignments.assigneeUserId, userId),
          query.status ? eq(schema.assignments.status, query.status) : undefined,
          cursorClause(cursor),
        ),
      )
      .orderBy(desc(schema.assignments.createdAt), desc(schema.assignments.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = rows.length > query.limit ? page[page.length - 1] : null;
    return {
      items: await toDtos(tx, page),
      nextCursor: last ? encodeCursor(last.createdAt, last.id) : null,
    };
  });
}
