import { z } from 'zod';
import { uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, route } from '@/lib/api/respond';
import { claimScenario } from '@/server/markets/scenarios';
import '@/lib/api/registry/markets';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: uuidSchema });

/** POST /api/v1/scenarios/:id/claim: the signed-in user takes over a scenario saved with their anonymous token. */
export const POST = route<{ params: Promise<unknown> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, paramsSchema);
  return json(await claimScenario(id, identity, ctx.correlationId), {
    correlationId: ctx.correlationId,
  });
});
