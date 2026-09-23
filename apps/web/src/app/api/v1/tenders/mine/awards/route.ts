import { partnerAwardListQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseQuery, route } from '@/lib/api/respond';
import '@/lib/api/registry/commercial';
import { listMyAwards } from '@/server/tenders/awards';

export const dynamic = 'force-dynamic';

export const GET = route(async (req, ctx) => {
  const identity = await getIdentity();
  const query = parseQuery(req, partnerAwardListQuerySchema);
  return json(await listMyAwards(identity, query, { correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});
