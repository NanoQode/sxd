import { ApiError, assignmentListQuerySchema, assignmentProposeSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import { listAssignments, proposeAssignment } from '@/server/assignments/service';
import '@/lib/api/registry/collaboration';

export const dynamic = 'force-dynamic';

/** GET /api/v1/assignments?serviceRequestId=|projectId= — assignments on one entity. */
export const GET = route(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const query = parseQuery(req, assignmentListQuerySchema);
  return json(await listAssignments(identity, query), { correlationId: ctx.correlationId });
});

/** POST /api/v1/assignments — staff propose an assignment to a staff member or partner. */
export const POST = route(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const body = await parseJson(req, assignmentProposeSchema);
  return json(await proposeAssignment(identity, body, { correlationId: ctx.correlationId }), {
    status: 201,
    correlationId: ctx.correlationId,
  });
});
