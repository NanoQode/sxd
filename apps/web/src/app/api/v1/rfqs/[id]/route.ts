import { rfqPatchSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { commercialIdParams } from '@/lib/api/registry/commercial';
import { getRfq, updateRfq } from '@/server/procurement/rfqs';

export const dynamic = 'force-dynamic';

export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, commercialIdParams);
  return json(await getRfq(identity, id, { correlationId: ctx.correlationId }), { correlationId: ctx.correlationId });
});

export const PATCH = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, commercialIdParams);
  const body = await parseJson(req, rfqPatchSchema);
  return json(await updateRfq(identity, id, body, { correlationId: ctx.correlationId }), { correlationId: ctx.correlationId });
});
