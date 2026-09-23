import { ApiError } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, route } from '@/lib/api/respond';
import '@/lib/api/registry/communications';
import { requestPhoneVerification } from '@/server/portal/phone-verification';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/me/phone/verification — send a 6-digit code to the phone saved
 * on the signed-in user's profile. Rate limited per user and per number; the
 * development adapter is labelled and never used in production.
 */
export const POST = route(async (_req, { correlationId }) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const result = await requestPhoneVerification({
    ...identity,
    ctx: { ...identity.ctx, correlationId },
  });
  return json(result, { correlationId });
});
