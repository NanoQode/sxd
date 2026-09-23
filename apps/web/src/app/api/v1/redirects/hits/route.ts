import { redirectHitSchema } from '@simplexd/contracts';
import { json, parseJson, route } from '@/lib/api/respond';
import { clientIp, enforceRateLimit, hashIp } from '@/lib/rate-limit';
import { recordRedirectHit } from '@/server/content/redirects';
import '@/lib/api/registry/content-public';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/redirects/hits — the proxy reports a served redirect after
 * responding (waitUntil). Only increments the counter of an active redirect;
 * rate limited per client so the counter cannot be inflated cheaply.
 */
export const POST = route(async (req, { correlationId }) => {
  await enforceRateLimit(`redirect-hits:${hashIp(clientIp(req))}`, {
    windowSeconds: 60,
    max: 120,
  });
  const body = await parseJson(req, redirectHitSchema);
  const counted = await recordRedirectHit(body.path);
  return json({ counted }, { correlationId });
});
