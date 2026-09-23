import { siteVisitSyncSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';
import { syncSiteVisits } from '@/server/projects/site-visits';

export const dynamic = 'force-dynamic';

export const POST = route(async (req, ctx) => {
  const identity = await getIdentity();
  const body = await parseJson(req, siteVisitSyncSchema);
  return json(await syncSiteVisits(identity, body, { correlationId: ctx.correlationId }), { status: 200, correlationId: ctx.correlationId });
});
