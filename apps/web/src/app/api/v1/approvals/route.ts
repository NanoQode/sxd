import { approvalsQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseQuery, route } from '@/lib/api/respond';
import { listApprovals } from '@/server/projects/approvals';

export const dynamic = 'force-dynamic';

export const GET = route(async (req, ctx) => {
  const identity = await getIdentity();
  const query = parseQuery(req, approvalsQuerySchema);
  return json(await listApprovals(identity, query), {
    status: 200,
    correlationId: ctx.correlationId,
  });
});
