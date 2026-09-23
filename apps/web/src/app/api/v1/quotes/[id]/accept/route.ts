import { z } from 'zod';
import { acceptQuote } from '@simplexd/finance';
import { quoteAcceptSchema, uuidSchema } from '@simplexd/contracts';
import { withIdempotency } from '@/lib/api/idempotency';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { financeContext } from '@/server/finance/runtime';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

/**
 * POST /api/v1/quotes/:id/accept — customer `org.quotes.accept` (Idempotency-Key
 * required): records the acceptance, issues the invoice when payment is
 * required and moves the engagement on.
 */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const { rt, fa, identity } = await financeContext(req, ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, quoteAcceptSchema);
  return withIdempotency(
    req,
    identity,
    'POST /api/v1/quotes/{id}/accept',
    { id, ...body },
    async () => json(await acceptQuote(rt, fa, id, body), { correlationId: ctx.correlationId }),
    { required: true },
  );
});
