import { ApiError } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, route } from '@/lib/api/respond';
import { listMyNotices } from '@/server/rentals/tenant';
import '@/lib/api/registry/rentals';

export const dynamic = 'force-dynamic';
export const GET = route(async (_req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  return json({ items: await listMyNotices(identity) }, { correlationId: ctx.correlationId });
});
