import { z } from 'zod';
import { voidInvoice } from '@simplexd/finance';
import { invoiceVoidSchema, uuidSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { financeContext } from '@/server/finance/runtime';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

/** POST /api/v1/invoices/:id/void — staff `finance.invoices.manage`: void with reason (reversing journal). */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const { rt, fa } = await financeContext(req, ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, invoiceVoidSchema);
  return json(await voidInvoice(rt, fa, id, body.reason), { correlationId: ctx.correlationId });
});
