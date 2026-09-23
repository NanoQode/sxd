import { z } from 'zod';
import { verifyPaymentAttempt } from '@simplexd/finance';
import { uuidSchema } from '@simplexd/contracts';
import { json, params, route } from '@/lib/api/respond';
import { financeContext } from '@/server/finance/runtime';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

/**
 * POST /api/v1/payment-attempts/:id/verify — customer or staff asks the
 * server to verify with the provider. Settlement happens only when status,
 * reference, amount and currency match; a redirect never settles.
 */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const { rt, fa } = await financeContext(req, ctx.correlationId);
  const { id } = await params(ctx, idParams);
  return json(await verifyPaymentAttempt(rt, fa, { id }, { source: 'verify' }), {
    correlationId: ctx.correlationId,
  });
});
