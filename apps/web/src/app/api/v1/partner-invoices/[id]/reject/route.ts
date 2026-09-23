import { partnerInvoiceRejectSchema, uuidSchema } from '@simplexd/contracts';
import { z } from 'zod';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { rejectPartnerInvoice } from '@/server/finance/partner-invoices';
import '@/lib/api/registry/partner-ops';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

/** POST /api/v1/partner-invoices/{id}/reject */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, partnerInvoiceRejectSchema);
  return json(
    await rejectPartnerInvoice(identity, id, body, { correlationId: ctx.correlationId }),
    {
      correlationId: ctx.correlationId,
    },
  );
});
