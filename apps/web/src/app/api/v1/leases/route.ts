import { ApiError, leaseCreateSchema, leaseListQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import { createLease, listLeases } from '@/server/rentals/leases';
import '@/lib/api/registry/rentals';

export const dynamic = 'force-dynamic';
/** GET /api/v1/leases — leases of the active organisation (staff may scope by organizationId). */
export const GET = route(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  return json(await listLeases(identity, parseQuery(req, leaseListQuerySchema)), { correlationId: ctx.correlationId });
});

/** POST /api/v1/leases — create a lease (`org.leases.manage` or staff `rentals.manage`). */
export const POST = route(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const body = await parseJson(req, leaseCreateSchema);
  return json(await createLease(identity, body, { correlationId: ctx.correlationId }), { status: 201, correlationId: ctx.correlationId });
});
