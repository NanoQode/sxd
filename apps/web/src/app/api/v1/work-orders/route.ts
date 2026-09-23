import { ApiError, workOrderCreateSchema, workOrderListQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import { createWorkOrder, listWorkOrders } from '@/server/maintenance/work-orders';
import '@/lib/api/registry/rentals';

export const dynamic = 'force-dynamic';
export const GET = route(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  return json(await listWorkOrders(identity, parseQuery(req, workOrderListQuerySchema)), {
    correlationId: ctx.correlationId,
  });
});

export const POST = route(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const body = await parseJson(req, workOrderCreateSchema);
  return json(await createWorkOrder(identity, body, { correlationId: ctx.correlationId }), {
    status: 201,
    correlationId: ctx.correlationId,
  });
});
