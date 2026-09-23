import { z } from 'zod';
import { rejectRefund } from '@simplexd/finance';
import { refundDecisionSchema, uuidSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { financeContext } from '@/server/finance/runtime';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

/** POST /api/v1/refunds/:id/reject — staff `finance.refunds.approve` with a reason. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const { rt, fa } = await financeContext(req, ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, refundDecisionSchema);
  return json(await rejectRefund(rt, fa, id, body), { correlationId: ctx.correlationId });
});
