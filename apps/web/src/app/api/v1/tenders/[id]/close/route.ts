import { tenderCloseSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { commercialIdParams } from '@/lib/api/registry/commercial';
import { closeTender } from '@/server/tenders/tenders';

export const dynamic = 'force-dynamic';

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, commercialIdParams);
  const body = await parseJson(req, tenderCloseSchema);
  return json(await closeTender(identity, id, body, { correlationId: ctx.correlationId }), { correlationId: ctx.correlationId });
});
