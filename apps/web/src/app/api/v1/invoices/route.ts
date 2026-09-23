import { createInvoice, listInvoices } from '@simplexd/finance';
import { invoiceCreateSchema, invoiceListQuerySchema } from '@simplexd/contracts';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import { financeContext } from '@/server/finance/runtime';

export const dynamic = 'force-dynamic';

/** GET /api/v1/invoices — the caller's organisation's invoices, or any organisation for staff `finance.read`. */
export const GET = route(async (req, { correlationId }) => {
  const { rt, fa } = await financeContext(req, correlationId);
  const query = parseQuery(req, invoiceListQuerySchema);
  return json(await listInvoices(rt, fa, query), { correlationId });
});

/** POST /api/v1/invoices — staff `finance.invoices.manage` (MFA): manual invoice (milestone, fee, other), optionally issued. */
export const POST = route(async (req, { correlationId }) => {
  const { rt, fa } = await financeContext(req, correlationId);
  const body = await parseJson(req, invoiceCreateSchema);
  return json(await createInvoice(rt, fa, body), { status: 201, correlationId });
});
