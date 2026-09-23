import { bidSubmitSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { withIdempotency } from '@/lib/api/idempotency';
import { commercialIdParams } from '@/lib/api/registry/commercial';
import { submitBid } from '@/server/tenders/bids';

export const dynamic = 'force-dynamic';

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, commercialIdParams);
  const body = await parseJson(req, bidSubmitSchema);
  return withIdempotency(req, identity, 'POST /api/v1/bids/{id}/submit'.replace('{id}', id), body, async () =>
    json(await submitBid(identity, id, body, { correlationId: ctx.correlationId }), { correlationId: ctx.correlationId }),
  );
});
