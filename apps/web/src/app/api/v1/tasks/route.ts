import { ApiError, taskCreateSchema, taskListQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import { createTask, listTasks } from '@/server/tasks/service';
import '@/lib/api/registry/collaboration';

export const dynamic = 'force-dynamic';

/** GET /api/v1/tasks?serviceRequestId=|projectId=|assignmentId= — tasks the caller may see on one entity. */
export const GET = route(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const query = parseQuery(req, taskListQuerySchema);
  return json(await listTasks(identity, query), { correlationId: ctx.correlationId });
});

/** POST /api/v1/tasks — staff create a task with explicit visibility. */
export const POST = route(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const body = await parseJson(req, taskCreateSchema);
  return json(await createTask(identity, body, { correlationId: ctx.correlationId }), {
    status: 201,
    correlationId: ctx.correlationId,
  });
});
