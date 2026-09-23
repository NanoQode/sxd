import { ApiError, phoneVerificationConfirmSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';
import '@/lib/api/registry/communications';
import { confirmPhoneVerification } from '@/server/portal/phone-verification';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/me/phone/verification/confirm — check the code; success marks
 * the profile number verified. Wrong codes count toward the attempt limit.
 */
export const POST = route(async (req, { correlationId }) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const body = await parseJson(req, phoneVerificationConfirmSchema);
  const result = await confirmPhoneVerification(
    { ...identity, ctx: { ...identity.ctx, correlationId } },
    body,
  );
  return json(result, { correlationId });
});
