import { ApiError, organizationUpdateSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';
import { listMemberships, updateActiveOrganization } from '@/server/portal/organizations';

export const dynamic = 'force-dynamic';

/** GET /api/v1/me/organizations — the caller's memberships with organisation names and the active one. */
export const GET = route(async (_req, { correlationId }) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  return json({ items: await listMemberships(identity) }, { correlationId });
});

/** PATCH /api/v1/me/organizations — name and ownership type of the active organisation (org.settings.manage). */
export const PATCH = route(async (req, { correlationId }) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const body = await parseJson(req, organizationUpdateSchema);
  return json(await updateActiveOrganization(identity, body, { correlationId }), { correlationId });
});
