import { ApiError, organizationInviteSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';
import { enforceRateLimit } from '@/lib/rate-limit';
import { inviteMember, listPendingInvitations } from '@/server/portal/organizations';

export const dynamic = 'force-dynamic';

/** GET /api/v1/me/organizations/invitations — pending invitations for the active organisation. */
export const GET = route(async (_req, { correlationId }) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  return json({ items: await listPendingInvitations(identity) }, { correlationId });
});

/** POST /api/v1/me/organizations/invitations — invite a household member or adviser (org.members.invite). */
export const POST = route(async (req, { correlationId }) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  await enforceRateLimit(`invitations:${identity.session.user.id}`, { windowSeconds: 3600, max: 20 });
  const body = await parseJson(req, organizationInviteSchema);
  return json(await inviteMember(identity, body, { correlationId }), { status: 201, correlationId });
});
