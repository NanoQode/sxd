import { z } from 'zod';
import { uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, route } from '@/lib/api/respond';
import { buildScenarioReport } from '@/server/markets/scenarios';
import '@/lib/api/registry/markets';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: uuidSchema });

/** GET /api/v1/scenarios/:id/report: dated comparison report from the latest stored snapshot. */
export const GET = route<{ params: Promise<unknown> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, paramsSchema);
  return json(await buildScenarioReport(id, identity, ctx.correlationId), {
    correlationId: ctx.correlationId,
  });
});
