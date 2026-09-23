import { z } from 'zod';
import { issueInvoice } from '@simplexd/finance';
import { invoiceIssueSchema, uuidSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { financeContext } from '@/server/finance/runtime';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

/** POST /api/v1/invoices/:id/issue — staff `finance.invoices.manage`: draft → issued with INV number and journal. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const { rt, fa } = await financeContext(req, ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, invoiceIssueSchema);
  return json(await issueInvoice(rt, fa, id, body), { correlationId: ctx.correlationId });
});
