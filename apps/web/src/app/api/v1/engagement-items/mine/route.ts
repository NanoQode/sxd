import { myEngagementItemsQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseQuery, route } from '@/lib/api/respond';
import { listMyEngagementItems } from '@/server/engagements/items';
import '@/lib/api/registry/diligence';

export const dynamic = 'force-dynamic';

/** GET /api/v1/engagement-items/mine — items assigned to the caller. */
export const GET = route(async (req, ctx) => {
  const identity = await getIdentity();
  const query = parseQuery(req, myEngagementItemsQuerySchema);
  return json(await listMyEngagementItems(identity, query), { correlationId: ctx.correlationId });
});
