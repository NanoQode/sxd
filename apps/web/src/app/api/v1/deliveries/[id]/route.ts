import { getIdentity } from '@/lib/auth/session';
import { json, params, route } from '@/lib/api/respond';
import { commercialIdParams } from '@/lib/api/registry/commercial';
import { getDelivery } from '@/server/procurement/deliveries';

export const dynamic = 'force-dynamic';

export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, commercialIdParams);
  return json(await getDelivery(identity, id, { correlationId: ctx.correlationId }), { correlationId: ctx.correlationId });
});
