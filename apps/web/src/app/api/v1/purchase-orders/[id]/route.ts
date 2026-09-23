import { getIdentity } from '@/lib/auth/session';
import { json, params, route } from '@/lib/api/respond';
import { commercialIdParams } from '@/lib/api/registry/commercial';
import { getPurchaseOrder } from '@/server/procurement/purchase-orders';

export const dynamic = 'force-dynamic';

export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, commercialIdParams);
  return json(await getPurchaseOrder(identity, id, { correlationId: ctx.correlationId }), { correlationId: ctx.correlationId });
});
