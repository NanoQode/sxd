import { discrepancyTransitionSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { discrepancyParams } from '@/lib/api/registry/commercial';
import { transitionDiscrepancy } from '@/server/procurement/deliveries';

export const dynamic = 'force-dynamic';

export const POST = route<{ params: Promise<{ id: string; did: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id, did } = await params(ctx, discrepancyParams);
  const body = await parseJson(req, discrepancyTransitionSchema);
  return json(await transitionDiscrepancy(identity, id, did, body, { correlationId: ctx.correlationId }), { correlationId: ctx.correlationId });
});
