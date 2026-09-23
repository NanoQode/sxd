import { comparisonRequestSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';
import { clientIp, enforceRateLimit, hashIp } from '@/lib/rate-limit';
import { runComparison } from '@/server/markets/comparisons';
import '@/lib/api/registry/markets';

export const dynamic = 'force-dynamic';

/** POST /api/v1/comparisons: two to four markets side by side; nothing persisted. */
export const POST = route(async (req, { correlationId }) => {
  const identity = await getIdentity();
  await enforceRateLimit(`comparisons:${identity.ctx.userId ?? hashIp(clientIp(req))}`, {
    windowSeconds: 60,
    max: 60,
  });
  const body = await parseJson(req, comparisonRequestSchema);
  const comparison = await runComparison(body, identity);
  return json(comparison, { correlationId });
});
