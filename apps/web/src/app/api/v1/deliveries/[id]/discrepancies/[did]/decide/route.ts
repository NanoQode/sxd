import { discrepancyDecideSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { partnerOpsDiscrepancyParams } from '@/lib/api/registry/partner-ops';
import { decideDiscrepancyResponse } from '@/server/procurement/discrepancy-responses';

export const dynamic = 'force-dynamic';

/** POST /api/v1/deliveries/{id}/discrepancies/{did}/decide — staff accept or reject the supplier's proposal. */
export const POST = route<{ params: Promise<{ id: string; did: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id, did } = await params(ctx, partnerOpsDiscrepancyParams);
  const body = await parseJson(req, discrepancyDecideSchema);
  return json(
    await decideDiscrepancyResponse(identity, id, did, body, { correlationId: ctx.correlationId }),
    { correlationId: ctx.correlationId },
  );
});
