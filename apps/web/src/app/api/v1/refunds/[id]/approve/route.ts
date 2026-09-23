import { z } from 'zod';
import { approveRefund } from '@simplexd/finance';
import { refundDecisionSchema, uuidSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { financeContext } from '@/server/finance/runtime';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

/** POST /api/v1/refunds/:id/approve — staff `finance.refunds.approve` (MFA, approver must differ from the requester). */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const { rt, fa } = await financeContext(req, ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, refundDecisionSchema);
  return json(await approveRefund(rt, fa, id, body), { correlationId: ctx.correlationId });
});
