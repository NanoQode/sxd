import { siteVisitRejectSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { partnerOpsIdParams } from '@/lib/api/registry/partner-ops';
import { rejectUnscheduledSiteVisit } from '@/server/projects/site-visits';

export const dynamic = 'force-dynamic';

/** POST /api/v1/site-visits/{id}/reject — staff reject an unscheduled visit before it is reviewed. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, partnerOpsIdParams);
  const body = await parseJson(req, siteVisitRejectSchema);
  return json(
    await rejectUnscheduledSiteVisit(identity, id, body, { correlationId: ctx.correlationId }),
    { correlationId: ctx.correlationId },
  );
});
