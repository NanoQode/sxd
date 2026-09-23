import { getIdentity } from '@/lib/auth/session';
import { json, params, route } from '@/lib/api/respond';
import { partnerOpsIdParams } from '@/lib/api/registry/partner-ops';
import { getPartnerInvoice } from '@/server/finance/partner-invoices';

export const dynamic = 'force-dynamic';

export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, partnerOpsIdParams);
  return json(await getPartnerInvoice(identity, id, { correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});
