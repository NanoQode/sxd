import { ApiError, myAssignmentsQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseQuery, route } from '@/lib/api/respond';
import { listMyAssignments } from '@/server/assignments/service';
import '@/lib/api/registry/collaboration';

export const dynamic = 'force-dynamic';

/** GET /api/v1/assignments/mine — the signed-in partner's or staff member's assignments. */
export const GET = route(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const query = parseQuery(req, myAssignmentsQuerySchema);
  return json(await listMyAssignments(identity, query), { correlationId: ctx.correlationId });
});
