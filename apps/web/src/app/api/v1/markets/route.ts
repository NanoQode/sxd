import { marketListQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseQuery, route } from '@/lib/api/respond';
import { listMarkets } from '@/server/markets/queries';
import '@/lib/api/registry/markets';

export const dynamic = 'force-dynamic';

/** GET /api/v1/markets?bbox=&objective=&evidenceStatus=&zone=&stateId=&q= */
export const GET = route(async (req, { correlationId }) => {
  const identity = await getIdentity();
  const query = parseQuery(req, marketListQuerySchema);
  const result = await listMarkets(query, identity);
  return json(result, {
    correlationId,
    headers: query.includeUnpublished ? {} : { 'cache-control': 'public, max-age=30' },
  });
});
