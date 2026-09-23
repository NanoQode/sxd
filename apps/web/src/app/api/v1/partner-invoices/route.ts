import { partnerInvoiceListQuerySchema, partnerInvoiceSubmitSchema } from '@simplexd/contracts';
import { withIdempotency } from '@/lib/api/idempotency';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import { getIdentity } from '@/lib/auth/session';
import { listPartnerInvoices, submitPartnerInvoice } from '@/server/finance/partner-invoices';
import '@/lib/api/registry/partner-ops';

export const dynamic = 'force-dynamic';

/** GET /api/v1/partner-invoices — a partner's own invoices, or every invoice for finance. */
export const GET = route(async (req, ctx) => {
  const identity = await getIdentity();
  const query = parseQuery(req, partnerInvoiceListQuerySchema);
  return json(await listPartnerInvoices(identity, query, { correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});

/** POST /api/v1/partner-invoices — submit an invoice against an awarded order or completed assignment. */
export const POST = route(async (req, ctx) => {
  const identity = await getIdentity();
  const body = await parseJson(req, partnerInvoiceSubmitSchema);
  return withIdempotency(req, identity, 'POST /api/v1/partner-invoices', body, async () =>
    json(await submitPartnerInvoice(identity, body, { correlationId: ctx.correlationId }), {
      status: 201,
      correlationId: ctx.correlationId,
    }),
  );
});
