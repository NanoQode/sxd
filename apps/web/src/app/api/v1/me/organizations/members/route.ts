import { ApiError } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, route } from '@/lib/api/respond';
import { listMembers } from '@/server/portal/organizations';

export const dynamic = 'force-dynamic';

/** GET /api/v1/me/organizations/members — members of the active organisation. */
export const GET = route(async (_req, { correlationId }) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  return json({ items: await listMembers(identity) }, { correlationId });
});
