import { purchaseOrderIssueSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { withIdempotency } from '@/lib/api/idempotency';
import { commercialIdParams } from '@/lib/api/registry/commercial';
import { issuePurchaseOrder } from '@/server/procurement/purchase-orders';

export const dynamic = 'force-dynamic';

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, commercialIdParams);
  const body = await parseJson(req, purchaseOrderIssueSchema);
  return withIdempotency(req, identity, 'POST /api/v1/purchase-orders/{id}/issue'.replace('{id}', id), body, async () =>
    json(await issuePurchaseOrder(identity, id, body, { correlationId: ctx.correlationId }), { correlationId: ctx.correlationId }),
  );
});
