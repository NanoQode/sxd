import { ApiError, tenantInvitationAcceptSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';
import { acceptTenantInvitation } from '@/server/rentals/leases';
import '@/lib/api/registry/rentals';

export const dynamic = 'force-dynamic';
/** POST /api/v1/tenant/invitations/accept — redeem a lease invitation token (signed in with the invited e-mail). */
export const POST = route(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const body = await parseJson(req, tenantInvitationAcceptSchema);
  return json(await acceptTenantInvitation(identity, body, { correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});
