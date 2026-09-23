import { partnerBidListQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseQuery, route } from '@/lib/api/respond';
import '@/lib/api/registry/commercial';
import { listMyBids } from '@/server/tenders/bids';

export const dynamic = 'force-dynamic';

export const GET = route(async (req, ctx) => {
  const identity = await getIdentity();
  const query = parseQuery(req, partnerBidListQuerySchema);
  return json(await listMyBids(identity, query, { correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});
