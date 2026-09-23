import { serviceRequestCreateSchema, serviceRequestListQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import { enforceRateLimit } from '@/lib/rate-limit';
import { ApiError } from '@simplexd/contracts';
import { createServiceRequest } from '@/server/requests/create';
import { listServiceRequests } from '@/server/requests/queries';

export const dynamic = 'force-dynamic';

/** GET /api/v1/service-requests — the caller's organisation's requests (row-level security). */
export const GET = route(async (req, { correlationId }) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const query = parseQuery(req, serviceRequestListQuerySchema);
  return json(await listServiceRequests(identity, query), { correlationId });
});

/** POST /api/v1/service-requests — customer intake creating a request in `inquiry`. */
export const POST = route(async (req, { correlationId }) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  await enforceRateLimit(`service-requests:create:${identity.session.user.id}`, {
    windowSeconds: 3600,
    max: 20,
  });
  const body = await parseJson(req, serviceRequestCreateSchema);
  const created = await createServiceRequest(body, identity, { correlationId });
  return json(created, { status: 201, correlationId });
});
