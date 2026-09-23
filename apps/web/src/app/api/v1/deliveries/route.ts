import { deliveryListQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseQuery, route } from '@/lib/api/respond';
import '@/lib/api/registry/commercial';
import { listDeliveries } from '@/server/procurement/deliveries';

export const dynamic = 'force-dynamic';

export const GET = route(async (req, ctx) => {
  const identity = await getIdentity();
  const query = parseQuery(req, deliveryListQuerySchema);
  return json(await listDeliveries(identity, query, { correlationId: ctx.correlationId }), { correlationId: ctx.correlationId });
});
