import 'server-only';
import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
import {
  ApiError,
  type MyTasksQuery,
  type Page,
  type TaskCreate,
  type TaskDto,
  type TaskListQuery,
  type TaskStatus,
} from '@simplexd/contracts';
import {
  appendOutbox,
  getDb,
  schema,
  withActor,
  type DbExecutor,
  type Transaction,
} from '@simplexd/db';
import { assertAllowed, authorizeAny, membershipFor } from '@simplexd/domain/authz';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import {
  ENTITY_STAFF_MANAGE,
  ENTITY_STAFF_READ,
  classifyViewer,
  entityResourceRef,
  staffAllowed,
  type EntityAccess,
  type ViewerClass,
} from '@/server/assignments/access';
import {
  actorContext,
  decodeCursor,
  demote,
  elevate,
  encodeCursor,
  iso,
  isPartnerIdentity,
  isStaffIdentity,
  requireUserId,
  uniqueIds,
  userNameMap,
  type ServiceOptions,
} from '@/server/assignments/shared';
import {
  canViewTask,
  isActiveStaffUser,
  resolveTaskParent,
  taskVisibilityFilter,
  type TaskParent,
  type TaskRow,
} from './access';

/**
 * Tasks on service requests, projects and assignments. Staff create and
 * assign them; the assignee, staff, or (for customer-action tasks) the
 * customer organisation completes them. Visibility is explicit and enforced in
 * SQL for every list: internal tasks never reach customers or partners.
 */

const OPEN_STATUSES: TaskStatus[] = ['todo', 'in_progress', 'blocked'];

function toDto(row: TaskRow, names: Map<string, string>): TaskDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    serviceRequestId: row.serviceRequestId,
    projectId: row.projectId,
    assignmentId: row.assignmentId,
    title: row.title,
    description: row.description,
    status: row.status,
    dueAt: iso(row.dueAt),
    assigneeUserId: row.assigneeUserId,
    assigneeName: row.assigneeUserId ? (names.get(row.assigneeUserId) ?? null) : null,
    visibility: row.visibility,
    requiresCustomerAction: row.requiresCustomerAction,
    completedAt: iso(row.completedAt),
    completedBy: row.completedBy,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function toDtos(tx: DbExecutor, rows: TaskRow[]): Promise<TaskDto[]> {
  const names = await userNameMap(
    tx,
    rows.map((r) => r.assigneeUserId),
  );
  return rows.map((r) => toDto(r, names));
}

async function loadTask(tx: DbExecutor, id: string): Promise<TaskRow | null> {
  const rows = await tx.select().from(schema.tasks).where(eq(schema.tasks.id, id));
  return rows[0] ?? null;
}

interface TaskContext {
  task: TaskRow;
  parent: TaskParent;
  viewer: ViewerClass;
}

/** Loads a task the caller may see: the SQL read, the parent entity and the visibility rule must all agree. */
async function requireVisibleTask(
  tx: Transaction,
  identity: RequestIdentity,
  id: string,
): Promise<TaskContext> {
  const userId = requireUserId(identity);
  let task = await loadTask(tx, id);
  if (!task && isPartnerIdentity(identity) && !isStaffIdentity(identity)) {
    // The tasks policy only shows a partner the rows assigned to them personally. To find out
    // whether this task sits on an entity the partner is assigned to, its parent ids are read
    // under a briefly elevated context; access is then proven under the partner's own context
    // (resolveTaskParent + classifyViewer + canViewTask) before anything is returned.
    await elevate(tx, identity.ctx);
    task = await loadTask(tx, id);
    await demote(tx, identity.ctx);
  }
  if (!task) throw new ApiError('not_found', 'task not found');
  const parent = await resolveTaskParent(tx, task);
  if (!parent) throw new ApiError('not_found', 'task not found');
  const ref = await entityResourceRef(tx, identity, parent.entity);
  const viewer = classifyViewer(
    identity,
    parent.entity,
    ref,
    ENTITY_STAFF_READ[parent.entity.type],
  );
  if (!viewer || !canViewTask(viewer, task, userId))
    throw new ApiError('not_found', 'task not found');
  return { task, parent, viewer };
}

async function requireStaffManage(
  tx: DbExecutor,
  identity: RequestIdentity,
  entity: EntityAccess,
): Promise<void> {
  if (!isStaffIdentity(identity)) throw new ApiError('forbidden', 'only staff manage tasks');
  const ref = await entityResourceRef(tx, identity, entity);
  assertAllowed(
    authorizeAny(
      identity.actor,
      ENTITY_STAFF_MANAGE[entity.type].map((staff) => ({ staff })),
      ref,
    ),
  );
}

/** An assignee must be staff, or a partner attached to the parent through an accepted/active assignment. */
async function assertAssigneeAllowed(
  tx: DbExecutor,
  parent: TaskParent,
  assigneeUserId: string,
  visibility: TaskRow['visibility'],
): Promise<void> {
  const [u] = await tx
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.id, assigneeUserId));
  if (!u) {
    throw new ApiError('validation_failed', 'assignee does not exist', {
      details: [{ path: 'assigneeUserId', message: 'unknown user' }],
    });
  }
  if (await isActiveStaffUser(tx, assigneeUserId)) return;
  if (visibility === 'internal') {
    throw new ApiError('validation_failed', 'internal tasks can only be assigned to staff', {
      details: [{ path: 'assigneeUserId', message: 'not staff' }],
    });
  }
  const attached =
    parent.entity.assigneeUserIds.includes(assigneeUserId) ||
    (parent.assignment !== null && parent.assignment.assigneeUserId === assigneeUserId);
  if (!attached) {
    throw new ApiError(
      'validation_failed',
      'assignee must be staff or hold an accepted assignment on this service request or project',
      { details: [{ path: 'assigneeUserId', message: 'not assigned to the parent' }] },
    );
  }
}

async function orgMemberIds(tx: DbExecutor, organizationId: string): Promise<string[]> {
  const rows = await tx
    .select({ userId: schema.member.userId, role: schema.member.role })
    .from(schema.member)
    .where(eq(schema.member.organizationId, organizationId));
  return uniqueIds(rows.filter((r) => r.role !== 'tenant').map((r) => r.userId));
}

async function emitAssigned(
  tx: DbExecutor,
  identity: RequestIdentity,
  task: TaskRow,
  options: ServiceOptions,
): Promise<void> {
  const recipients = task.assigneeUserId
    ? [task.assigneeUserId]
    : task.requiresCustomerAction
      ? await orgMemberIds(tx, task.organizationId)
      : [];
  if (recipients.length === 0) return;
  await appendOutbox(tx, {
    eventType: 'task.assigned',
    aggregateType: 'task',
    aggregateId: task.id,
    organizationId: task.organizationId,
    actorUserId: identity.session?.user.id ?? null,
    payload: {
      taskId: task.id,
      organizationId: task.organizationId,
      serviceRequestId: task.serviceRequestId,
      projectId: task.projectId,
      requiresCustomerAction: task.requiresCustomerAction,
      recipientUserIds: recipients.filter((id) => id !== identity.session?.user.id),
    },
    correlationId: options.correlationId ?? null,
  });
}

export async function createTask(
  identity: RequestIdentity,
  input: TaskCreate,
  options: ServiceOptions = {},
): Promise<TaskDto> {
  const userId = requireUserId(identity);
  const ctx = actorContext(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const parent = await resolveTaskParent(tx, input);
    if (!parent)
      throw new ApiError('not_found', 'service request, project or assignment not found');
    await requireStaffManage(tx, identity, parent.entity);
    if (input.assigneeUserId)
      await assertAssigneeAllowed(tx, parent, input.assigneeUserId, input.visibility);
    const [row] = await tx
      .insert(schema.tasks)
      .values({
        organizationId: parent.entity.organizationId!,
        serviceRequestId: input.serviceRequestId ?? parent.assignment?.serviceRequestId ?? null,
        projectId: input.projectId ?? parent.assignment?.projectId ?? null,
        assignmentId: input.assignmentId ?? null,
        title: input.title,
        description: input.description ?? null,
        status: 'todo',
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        assigneeUserId: input.assigneeUserId ?? null,
        visibility: input.visibility,
        requiresCustomerAction: input.requiresCustomerAction,
        createdBy: userId,
      })
      .returning();
    await recordAudit(tx, identity, {
      action: 'task.created',
      entityType: 'task',
      entityId: row!.id,
      organizationId: row!.organizationId,
      after: {
        title: input.title,
        visibility: input.visibility,
        requiresCustomerAction: input.requiresCustomerAction,
        assigneeUserId: input.assigneeUserId ?? null,
        serviceRequestId: row!.serviceRequestId,
        projectId: row!.projectId,
        assignmentId: row!.assignmentId,
      },
      correlationId: options.correlationId,
    });
    await emitAssigned(tx, identity, row!, options);
    const [dto] = await toDtos(tx, [row!]);
    return dto!;
  });
}

export async function getTask(identity: RequestIdentity, id: string): Promise<TaskDto> {
  return withActor(getDb(), identity.ctx, async (tx) => {
    const { task } = await requireVisibleTask(tx, identity, id);
    const [dto] = await toDtos(tx, [task]);
    return dto!;
  });
}

function cursorClause(cursor: { createdAt: Date; id: string } | null) {
  return cursor
    ? or(
        lt(schema.tasks.createdAt, cursor.createdAt),
        and(eq(schema.tasks.createdAt, cursor.createdAt), lt(schema.tasks.id, cursor.id)),
      )
    : undefined;
}

/** Tasks on one service request, project or assignment, filtered by what the caller may see. */
export async function listTasks(
  identity: RequestIdentity,
  query: TaskListQuery,
): Promise<Page<TaskDto>> {
  const userId = requireUserId(identity);
  return withActor(getDb(), identity.ctx, async (tx) => {
    const parent = await resolveTaskParent(tx, query);
    if (!parent)
      throw new ApiError('not_found', 'service request, project or assignment not found');
    const ref = await entityResourceRef(tx, identity, parent.entity);
    const viewer = classifyViewer(
      identity,
      parent.entity,
      ref,
      ENTITY_STAFF_READ[parent.entity.type],
    );
    if (!viewer) throw new ApiError('forbidden', 'you do not have access to this resource');
    if (viewer === 'assignee' && !isStaffIdentity(identity)) {
      // The tasks policy only exposes rows assigned to the partner personally; partner-visible
      // tasks on an entity they are assigned to need the elevated read below. The assignment
      // was proven under the partner's own context (resolveTaskParent / classifyViewer) and
      // taskVisibilityFilter keeps internal and customer-only rows out of the result.
      await elevate(tx, identity.ctx);
    }
    const cursor = decodeCursor(query.cursor);
    const rows = await tx
      .select()
      .from(schema.tasks)
      .where(
        and(
          query.assignmentId
            ? eq(schema.tasks.assignmentId, query.assignmentId)
            : query.serviceRequestId
              ? eq(schema.tasks.serviceRequestId, query.serviceRequestId)
              : eq(schema.tasks.projectId, query.projectId!),
          query.status ? eq(schema.tasks.status, query.status) : undefined,
          taskVisibilityFilter(viewer, userId),
          cursorClause(cursor),
        ),
      )
      .orderBy(desc(schema.tasks.createdAt), desc(schema.tasks.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = rows.length > query.limit ? page[page.length - 1] : null;
    return {
      items: await toDtos(tx, page),
      nextCursor: last ? encodeCursor(last.createdAt, last.id) : null,
    };
  });
}

/**
 * "My tasks": staff and partners see tasks assigned to them; customers see
 * the tasks awaiting their organisation's action plus anything assigned to
 * them personally. This feeds the portal home "awaiting your approval" list.
 */
export async function listMyTasks(
  identity: RequestIdentity,
  query: MyTasksQuery,
): Promise<Page<TaskDto>> {
  const userId = requireUserId(identity);
  const orgId = identity.ctx.organizationId;
  const customerScope =
    !isStaffIdentity(identity) &&
    orgId !== null &&
    membershipFor(identity.actor, orgId) !== undefined &&
    authorizeAny(identity.actor, [{ org: 'org.read' }], {
      type: 'organization',
      organizationId: orgId,
    }).allowed;
  const cursor = decodeCursor(query.cursor);
  return withActor(getDb(), identity.ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.tasks)
      .where(
        and(
          customerScope
            ? or(
                eq(schema.tasks.assigneeUserId, userId),
                and(
                  eq(schema.tasks.organizationId, orgId!),
                  eq(schema.tasks.requiresCustomerAction, true),
                  inArray(schema.tasks.visibility, ['customer', 'all']),
                ),
              )
            : eq(schema.tasks.assigneeUserId, userId),
          isStaffIdentity(identity)
            ? undefined
            : inArray(schema.tasks.visibility, ['customer', 'partner', 'all']),
          query.status
            ? eq(schema.tasks.status, query.status)
            : inArray(schema.tasks.status, OPEN_STATUSES),
          cursorClause(cursor),
        ),
      )
      .orderBy(desc(schema.tasks.createdAt), desc(schema.tasks.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = rows.length > query.limit ? page[page.length - 1] : null;
    return {
      items: await toDtos(tx, page),
      nextCursor: last ? encodeCursor(last.createdAt, last.id) : null,
    };
  });
}

export async function assignTask(
  identity: RequestIdentity,
  id: string,
  input: { assigneeUserId: string | null },
  options: ServiceOptions = {},
): Promise<TaskDto> {
  const ctx = actorContext(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const { task, parent } = await requireVisibleTask(tx, identity, id);
    await requireStaffManage(tx, identity, parent.entity);
    if (task.status === 'done' || task.status === 'cancelled') {
      throw new ApiError('invalid_transition', `a ${task.status} task cannot be reassigned`);
    }
    if (input.assigneeUserId)
      await assertAssigneeAllowed(tx, parent, input.assigneeUserId, task.visibility);
    const [row] = await tx
      .update(schema.tasks)
      .set({ assigneeUserId: input.assigneeUserId })
      .where(eq(schema.tasks.id, id))
      .returning();
    await recordAudit(tx, identity, {
      action: 'task.assigned',
      entityType: 'task',
      entityId: id,
      organizationId: task.organizationId,
      before: { assigneeUserId: task.assigneeUserId },
      after: { assigneeUserId: input.assigneeUserId },
      correlationId: options.correlationId,
    });
    if (input.assigneeUserId && input.assigneeUserId !== task.assigneeUserId) {
      await emitAssigned(tx, identity, row!, options);
    }
    const [dto] = await toDtos(tx, [row!]);
    return dto!;
  });
}

/** Whether the caller may complete, block or unblock the task (staff, assignee, or the customer for customer-action tasks). */
async function assertCanWork(
  tx: DbExecutor,
  identity: RequestIdentity,
  ctxTask: TaskContext,
  action: 'complete' | 'block' | 'unblock',
): Promise<'staff' | 'assignee' | 'customer'> {
  const userId = requireUserId(identity);
  const { task, parent, viewer } = ctxTask;
  if (task.assigneeUserId === userId) return 'assignee';
  if (isStaffIdentity(identity)) {
    const ref = await entityResourceRef(tx, identity, parent.entity);
    if (staffAllowed(identity, ENTITY_STAFF_MANAGE[parent.entity.type], ref)) return 'staff';
  }
  if (action === 'complete' && task.requiresCustomerAction && viewer === 'customer') {
    // Acting for the organisation: members who can raise requests, or approvers who accept milestones.
    const decision = authorizeAny(
      identity.actor,
      [{ org: 'org.requests.create' }, { org: 'org.milestones.accept' }],
      { type: 'task', id: task.id, organizationId: task.organizationId },
    );
    if (decision.allowed) return 'customer';
  }
  throw new ApiError('forbidden', `you may not ${action} this task`);
}

async function transition(
  tx: DbExecutor,
  identity: RequestIdentity,
  task: TaskRow,
  from: TaskStatus[],
  to: TaskStatus,
  patch: Partial<typeof schema.tasks.$inferInsert>,
  reason: string | null,
  options: ServiceOptions,
): Promise<TaskRow> {
  if (!from.includes(task.status)) {
    throw new ApiError('invalid_transition', `task is ${task.status}; cannot move to ${to}`, {
      details: { from: task.status, to },
    });
  }
  const [row] = await tx
    .update(schema.tasks)
    .set({ status: to, ...patch })
    .where(and(eq(schema.tasks.id, task.id), inArray(schema.tasks.status, from)))
    .returning();
  if (!row) throw new ApiError('invalid_transition', 'task changed concurrently');
  await recordAudit(tx, identity, {
    action: `task.${to === 'done' ? 'completed' : to === 'todo' ? 'unblocked' : to}`,
    entityType: 'task',
    entityId: task.id,
    organizationId: task.organizationId,
    before: { status: task.status },
    after: { status: to },
    reason,
    correlationId: options.correlationId,
  });
  return row;
}

export async function completeTask(
  identity: RequestIdentity,
  id: string,
  input: { note?: string } = {},
  options: ServiceOptions = {},
): Promise<TaskDto> {
  const userId = requireUserId(identity);
  const ctx = actorContext(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const taskCtx = await requireVisibleTask(tx, identity, id);
    await assertCanWork(tx, identity, taskCtx, 'complete');
    const row = await transition(
      tx,
      identity,
      taskCtx.task,
      ['todo', 'in_progress'],
      'done',
      { completedAt: new Date(), completedBy: userId },
      input.note ?? null,
      options,
    );
    await appendOutbox(tx, {
      eventType: 'task.completed',
      aggregateType: 'task',
      aggregateId: row.id,
      organizationId: row.organizationId,
      actorUserId: userId,
      payload: {
        taskId: row.id,
        organizationId: row.organizationId,
        serviceRequestId: row.serviceRequestId,
        projectId: row.projectId,
        completedBy: userId,
        recipientUserIds: uniqueIds([row.createdBy, row.assigneeUserId]).filter(
          (u) => u !== userId,
        ),
      },
      correlationId: options.correlationId ?? null,
    });
    const [dto] = await toDtos(tx, [row]);
    return dto!;
  });
}

export async function blockTask(
  identity: RequestIdentity,
  id: string,
  input: { reason: string },
  options: ServiceOptions = {},
): Promise<TaskDto> {
  const ctx = actorContext(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const taskCtx = await requireVisibleTask(tx, identity, id);
    await assertCanWork(tx, identity, taskCtx, 'block');
    const row = await transition(
      tx,
      identity,
      taskCtx.task,
      ['todo', 'in_progress'],
      'blocked',
      {},
      input.reason,
      options,
    );
    const [dto] = await toDtos(tx, [row]);
    return dto!;
  });
}

export async function unblockTask(
  identity: RequestIdentity,
  id: string,
  input: { reason?: string } = {},
  options: ServiceOptions = {},
): Promise<TaskDto> {
  const ctx = actorContext(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const taskCtx = await requireVisibleTask(tx, identity, id);
    await assertCanWork(tx, identity, taskCtx, 'unblock');
    const row = await transition(
      tx,
      identity,
      taskCtx.task,
      ['blocked'],
      'todo',
      {},
      input.reason ?? null,
      options,
    );
    const [dto] = await toDtos(tx, [row]);
    return dto!;
  });
}

export async function cancelTask(
  identity: RequestIdentity,
  id: string,
  input: { reason: string },
  options: ServiceOptions = {},
): Promise<TaskDto> {
  const ctx = actorContext(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const { task, parent } = await requireVisibleTask(tx, identity, id);
    await requireStaffManage(tx, identity, parent.entity);
    const row = await transition(
      tx,
      identity,
      task,
      ['todo', 'in_progress', 'blocked'],
      'cancelled',
      {},
      input.reason,
      options,
    );
    const [dto] = await toDtos(tx, [row]);
    return dto!;
  });
}
