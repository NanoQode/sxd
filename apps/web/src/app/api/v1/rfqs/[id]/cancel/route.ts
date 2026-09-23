import { rfqCancelSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { commercialIdParams } from '@/lib/api/registry/commercial';
import { cancelRfq } from '@/server/procurement/rfqs';

export const dynamic = 'force-dynamic';

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, commercialIdParams);
  const body = await parseJson(req, rfqCancelSchema);
  return json(await cancelRfq(identity, id, body, { correlationId: ctx.correlationId }), { correlationId: ctx.correlationId });
});
