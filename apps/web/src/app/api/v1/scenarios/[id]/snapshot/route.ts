import { z } from 'zod';
import { uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, route } from '@/lib/api/respond';
import { clientIp, enforceRateLimit, hashIp } from '@/lib/rate-limit';
import { snapshotScenario } from '@/server/markets/scenarios';
import '@/lib/api/registry/markets';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: uuidSchema });

/** POST /api/v1/scenarios/:id/snapshot: runs and stores the scenario recommendation immutably. */
export const POST = route<{ params: Promise<unknown> }>(async (req, ctx) => {
  const identity = await getIdentity();
  await enforceRateLimit(`scenarios:snapshot:${identity.ctx.userId ?? hashIp(clientIp(req))}`, {
    windowSeconds: 60,
    max: 30,
  });
  const { id } = await params(ctx, paramsSchema);
  return json(await snapshotScenario(id, identity, ctx.correlationId), {
    status: 201,
    correlationId: ctx.correlationId,
  });
});
