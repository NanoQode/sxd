import { z } from 'zod';
import { json, params, route } from '@/lib/api/respond';
import { clientIp, enforceRateLimit, hashIp } from '@/lib/rate-limit';
import { getSharedScenario } from '@/server/markets/scenarios';
import '@/lib/api/registry/markets';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ token: z.string().min(16).max(128) });

/** GET /api/v1/scenarios/shared/:token: read-only view of a privately shared scenario. */
export const GET = route<{ params: Promise<unknown> }>(async (req, ctx) => {
  await enforceRateLimit(`scenarios:shared:${hashIp(clientIp(req))}`, {
    windowSeconds: 60,
    max: 60,
  });
  const { token } = await params(ctx, paramsSchema);
  return json(await getSharedScenario(token), { correlationId: ctx.correlationId });
});
