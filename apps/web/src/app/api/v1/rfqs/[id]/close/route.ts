import { getIdentity } from '@/lib/auth/session';
import { json, params, route } from '@/lib/api/respond';
import { commercialIdParams } from '@/lib/api/registry/commercial';
import { closeRfq } from '@/server/procurement/rfqs';

export const dynamic = 'force-dynamic';

export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, commercialIdParams);
  return json(await closeRfq(identity, id, { correlationId: ctx.correlationId }), { correlationId: ctx.correlationId });
});
