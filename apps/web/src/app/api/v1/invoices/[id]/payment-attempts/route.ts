import { z } from 'zod';
import { createPaymentAttempt } from '@simplexd/finance';
import { paymentAttemptCreateSchema, uuidSchema } from '@simplexd/contracts';
import { withIdempotency } from '@/lib/api/idempotency';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { financeContext } from '@/server/finance/runtime';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

/**
 * POST /api/v1/invoices/:id/payment-attempts — customer `org.invoices.pay`
 * (Idempotency-Key required): server-created attempt with an immutable
 * reference, amount and currency; hosted checkout initialised with the
 * active provider (or the labelled development adapter outside production).
 * The response never includes provider secrets.
 */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const { rt, fa, identity } = await financeContext(req, ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, paymentAttemptCreateSchema);
  return withIdempotency(
    req,
    identity,
    'POST /api/v1/invoices/{id}/payment-attempts',
    { id, ...body },
    async () => json(await createPaymentAttempt(rt, fa, id, body), { status: 201, correlationId: ctx.correlationId }),
    { required: true },
  );
});
