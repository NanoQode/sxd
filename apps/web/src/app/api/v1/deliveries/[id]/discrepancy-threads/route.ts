import { getIdentity } from '@/lib/auth/session';
import { json, params, route } from '@/lib/api/respond';
import { partnerOpsIdParams } from '@/lib/api/registry/partner-ops';
import { listDiscrepancyThreads } from '@/server/procurement/discrepancy-responses';

export const dynamic = 'force-dynamic';

/** GET /api/v1/deliveries/{id}/discrepancy-threads — supplier responses and staff decisions per discrepancy. */
export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, partnerOpsIdParams);
  return json(await listDiscrepancyThreads(identity, id, { correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});
