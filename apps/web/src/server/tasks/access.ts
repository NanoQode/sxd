import 'server-only';
import { and, eq, inArray, isNull, ne, or, type SQL } from 'drizzle-orm';
import { ApiError, type Visibility } from '@simplexd/contracts';
import { schema, type DbExecutor } from '@simplexd/db';
import { resolveEntity, type EntityAccess, type ViewerClass } from '@/server/assignments/access';

export type TaskRow = typeof schema.tasks.$inferSelect;
type AssignmentRow = typeof schema.assignments.$inferSelect;

export interface TaskParent {
  entity: EntityAccess;
  assignment: AssignmentRow | null;
}

/**
 * Resolves the service request / project a task belongs to (directly or via
 * its assignment) under the caller's row-level security context. Returns
 * null when the caller cannot see the parent, which callers report as
 * `not_found`.
 */
export async function resolveTaskParent(
  tx: DbExecutor,
  refs: {
    serviceRequestId?: string | null;
    projectId?: string | null;
    assignmentId?: string | null;
  },
): Promise<TaskParent | null> {
  let assignment: AssignmentRow | null = null;
  let serviceRequestId = refs.serviceRequestId ?? null;
  let projectId = refs.projectId ?? null;
  if (refs.assignmentId) {
    const [row] = await tx
      .select()
      .from(schema.assignments)
      .where(eq(schema.assignments.id, refs.assignmentId));
    if (!row) return null;
    assignment = row;
    if (serviceRequestId && row.serviceRequestId && serviceRequestId !== row.serviceRequestId) {
      throw new ApiError('validation_failed', 'assignment belongs to a different service request');
    }
    if (projectId && row.projectId && projectId !== row.projectId) {
      throw new ApiError('validation_failed', 'assignment belongs to a different project');
    }
    serviceRequestId = serviceRequestId ?? row.serviceRequestId;
    projectId = projectId ?? row.projectId;
  }
  const entity = serviceRequestId
    ? await resolveEntity(tx, 'service_request', serviceRequestId)
    : projectId
      ? await resolveEntity(tx, 'project', projectId)
      : null;
  if (!entity) return null;
  return { entity, assignment };
}

/** Visibility a class of viewer may see; `internal` never leaves the staff. */
export const VISIBLE_TO: Record<Exclude<ViewerClass, 'staff'>, Visibility[]> = {
  customer: ['customer', 'all'],
  assignee: ['partner', 'all'],
};

/** SQL filter mirroring `canViewTask`, applied to every list query. */
export function taskVisibilityFilter(viewer: ViewerClass, userId: string): SQL | undefined {
  switch (viewer) {
    case 'staff':
      return undefined;
    case 'customer':
      return inArray(schema.tasks.visibility, VISIBLE_TO.customer);
    case 'assignee':
      return and(
        ne(schema.tasks.visibility, 'internal'),
        or(
          inArray(schema.tasks.visibility, VISIBLE_TO.assignee),
          eq(schema.tasks.assigneeUserId, userId),
        ),
      );
  }
}

export function canViewTask(viewer: ViewerClass, task: TaskRow, userId: string): boolean {
  switch (viewer) {
    case 'staff':
      return true;
    case 'customer':
      return VISIBLE_TO.customer.includes(task.visibility);
    case 'assignee':
      return (
        task.visibility !== 'internal' &&
        (VISIBLE_TO.assignee.includes(task.visibility) || task.assigneeUserId === userId)
      );
  }
}

export async function isActiveStaffUser(tx: DbExecutor, userId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: schema.staffRoles.id })
    .from(schema.staffRoles)
    .where(and(eq(schema.staffRoles.userId, userId), isNull(schema.staffRoles.revokedAt)))
    .limit(1);
  return Boolean(row);
}
