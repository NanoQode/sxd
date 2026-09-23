import { z } from 'zod';
import { rejectBankTransferReceipt } from '@simplexd/finance';
import { bankTransferRejectSchema, uuidSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { financeContext } from '@/server/finance/runtime';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

/** POST /api/v1/bank-transfer-receipts/:id/reject — staff `finance.allocations.manage` with a note. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const { rt, fa } = await financeContext(req, ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, bankTransferRejectSchema);
  return json(await rejectBankTransferReceipt(rt, fa, id, body), { correlationId: ctx.correlationId });
});
