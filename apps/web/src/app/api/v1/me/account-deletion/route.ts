import { ApiError, accountDeletionRequestSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';
import { clientIp, enforceRateLimit, hashIp } from '@/lib/rate-limit';
import { requestAccountDeletion } from '@/server/portal/account-deletion';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/me/account-deletion — records a deletion request as a support
 * lead plus an audit entry and returns the retention policy. Nothing is deleted
 * immediately: accounting and legal records have statutory retention.
 */
export const POST = route(async (req, { correlationId }) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  await enforceRateLimit(`account-deletion:${identity.session.user.id}`, { windowSeconds: 3600, max: 5 });
  const body = await parseJson(req, accountDeletionRequestSchema);
  const result = await requestAccountDeletion(identity, body, { correlationId, ipHash: hashIp(clientIp(req)) });
  return json(result, { status: result.alreadyRequested ? 200 : 201, correlationId });
});
