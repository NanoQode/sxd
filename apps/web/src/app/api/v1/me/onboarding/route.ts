import { ApiError, onboardingCompleteSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';
import { completeOnboarding } from '@/server/portal/profile';

export const dynamic = 'force-dynamic';

/** POST /api/v1/me/onboarding — marks onboarding complete (optionally saving goals). */
export const POST = route(async (req, { correlationId }) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const body = await parseJson(req, onboardingCompleteSchema);
  return json(await completeOnboarding(identity, body), { correlationId });
});
