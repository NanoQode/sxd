import { requestRefund } from '@simplexd/finance';
import { refundRequestSchema } from '@simplexd/contracts';
import { withIdempotency } from '@/lib/api/idempotency';
import { json, parseJson, route } from '@/lib/api/respond';
import { financeContext } from '@/server/finance/runtime';

export const dynamic = 'force-dynamic';

/** POST /api/v1/refunds — finance `finance.refunds.request` or the paying organisation (Idempotency-Key required). */
export const POST = route(async (req, { correlationId }) => {
  const { rt, fa, identity } = await financeContext(req, correlationId);
  const body = await parseJson(req, refundRequestSchema);
  return withIdempotency(
    req,
    identity,
    'POST /api/v1/refunds',
    body,
    async () => json(await requestRefund(rt, fa, body), { status: 201, correlationId }),
    { required: true },
  );
});
