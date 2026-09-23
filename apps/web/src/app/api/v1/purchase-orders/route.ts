import { purchaseOrderCreateSchema, purchaseOrderListQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import '@/lib/api/registry/commercial';
import { createPurchaseOrder, listPurchaseOrders } from '@/server/procurement/purchase-orders';

export const dynamic = 'force-dynamic';

export const GET = route(async (req, ctx) => {
  const identity = await getIdentity();
  const query = parseQuery(req, purchaseOrderListQuerySchema);
  return json(await listPurchaseOrders(identity, query, { correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});

export const POST = route(async (req, ctx) => {
  const identity = await getIdentity();
  const body = await parseJson(req, purchaseOrderCreateSchema);
  return json(await createPurchaseOrder(identity, body, { correlationId: ctx.correlationId }), {
    status: 201,
    correlationId: ctx.correlationId,
  });
});
