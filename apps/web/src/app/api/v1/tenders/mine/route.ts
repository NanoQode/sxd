import { partnerTenderListQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseQuery, route } from '@/lib/api/respond';
import '@/lib/api/registry/commercial';
import { listMyInvitedTenders } from '@/server/tenders/tenders';

export const dynamic = 'force-dynamic';

export const GET = route(async (req, ctx) => {
  const identity = await getIdentity();
  const query = parseQuery(req, partnerTenderListQuerySchema);
  return json(await listMyInvitedTenders(identity, query, { correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});
