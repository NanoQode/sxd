import { z } from 'zod';
import { submitBankTransferReceipt } from '@simplexd/finance';
import { bankTransferReceiptCreateSchema, uuidSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { financeContext } from '@/server/finance/runtime';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

/** POST /api/v1/invoices/:id/bank-transfer-receipts — customer `org.invoices.pay` declares a transfer (not cleared money). */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const { rt, fa } = await financeContext(req, ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, bankTransferReceiptCreateSchema);
  return json(await submitBankTransferReceipt(rt, fa, id, body), { status: 201, correlationId: ctx.correlationId });
});
