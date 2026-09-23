import { ApiError, myTasksQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseQuery, route } from '@/lib/api/respond';
import { listMyTasks } from '@/server/tasks/service';
import '@/lib/api/registry/collaboration';

export const dynamic = 'force-dynamic';

/** GET /api/v1/tasks/mine — tasks awaiting the caller (customer action or personal assignment). */
export const GET = route(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const query = parseQuery(req, myTasksQuerySchema);
  return json(await listMyTasks(identity, query), { correlationId: ctx.correlationId });
});
