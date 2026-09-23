import { z } from 'zod';
import { scenarioVerificationRequestSchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { clientIp, enforceRateLimit, hashIp } from '@/lib/rate-limit';
import { requestVerification } from '@/server/markets/scenarios';
import '@/lib/api/registry/markets';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: uuidSchema });

/** POST /api/v1/scenarios/:id/request-verification: creates a map_scenario lead. */
export const POST = route<{ params: Promise<unknown> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const ip = clientIp(req);
  await enforceRateLimit(`scenarios:verify:${identity.ctx.userId ?? hashIp(ip)}`, {
    windowSeconds: 3600,
    max: 10,
  });
  const { id } = await params(ctx, paramsSchema);
  const body = await parseJson(req, scenarioVerificationRequestSchema);
  const result = await requestVerification(id, body, identity, {
    ipHash: hashIp(ip),
    userAgent: req.headers.get('user-agent'),
    correlationId: ctx.correlationId,
  });
  return json(result, { status: 201, correlationId: ctx.correlationId });
});
