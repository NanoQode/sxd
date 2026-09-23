import { siteVisitUnscheduledStartSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { partnerOpsIdParams } from '@/lib/api/registry/partner-ops';
import { startUnscheduledSiteVisit } from '@/server/projects/site-visits';

export const dynamic = 'force-dynamic';

/** POST /api/v1/projects/{id}/site-visits/unscheduled — an assigned inspector starts an ad-hoc visit. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, partnerOpsIdParams);
  const body = await parseJson(req, siteVisitUnscheduledStartSchema);
  const result = await startUnscheduledSiteVisit(identity, id, body, {
    correlationId: ctx.correlationId,
  });
  return json(result, {
    status: result.idempotentReplay ? 200 : 201,
    correlationId: ctx.correlationId,
  });
});
