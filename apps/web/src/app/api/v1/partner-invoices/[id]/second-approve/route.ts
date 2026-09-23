import { uuidSchema } from '@simplexd/contracts';
import { z } from 'zod';
import { getIdentity } from '@/lib/auth/session';
import { json, params, route } from '@/lib/api/respond';
import { secondApprovePartnerInvoice } from '@/server/finance/partner-invoices';
import '@/lib/api/registry/partner-ops';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

/** POST /api/v1/partner-invoices/{id}/second-approve */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, idParams);
  return json(await secondApprovePartnerInvoice(identity, id, { correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});
