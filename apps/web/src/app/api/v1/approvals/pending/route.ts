import { getIdentity } from '@/lib/auth/session';
import { json, route } from '@/lib/api/respond';
import { listPendingApprovals } from '@/server/projects/approvals';

export const dynamic = 'force-dynamic';

export const GET = route(async (_req, ctx) => {
  const identity = await getIdentity();
  return json(await listPendingApprovals(identity), { status: 200, correlationId: ctx.correlationId });
});
