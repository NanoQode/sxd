import { z } from 'zod';
import { siteVisitListQuerySchema, siteVisitScheduleSchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, parseQuery, route } from '@/lib/api/respond';
import { listSiteVisits, scheduleSiteVisit } from '@/server/projects/site-visits';

export const dynamic = 'force-dynamic';

export const GET = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const query = parseQuery(req, siteVisitListQuerySchema);
  return json(await listSiteVisits(identity, id, query), {
    status: 200,
    correlationId: ctx.correlationId,
  });
});

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, siteVisitScheduleSchema);
  const result = await scheduleSiteVisit(identity, id, body, { correlationId: ctx.correlationId });
  return json(result, {
    status: result.idempotentReplay ? 200 : 201,
    correlationId: ctx.correlationId,
  });
});
