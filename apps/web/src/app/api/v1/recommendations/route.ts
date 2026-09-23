import { recommendationRequestSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';
import { clientIp, enforceRateLimit, hashIp } from '@/lib/rate-limit';
import { runRecommendation } from '@/server/markets/recommendations';
import '@/lib/api/registry/markets';

export const dynamic = 'force-dynamic';

/** POST /api/v1/recommendations: deterministic ranking under the active policy; nothing persisted. */
export const POST = route(async (req, { correlationId }) => {
  const identity = await getIdentity();
  await enforceRateLimit(`recommendations:${identity.ctx.userId ?? hashIp(clientIp(req))}`, {
    windowSeconds: 60,
    max: 60,
  });
  const body = await parseJson(req, recommendationRequestSchema);
  const run = await runRecommendation(body, identity);
  return json(run.response, { correlationId });
});
