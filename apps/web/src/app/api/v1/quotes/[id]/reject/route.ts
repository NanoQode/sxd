import { z } from 'zod';
import { rejectQuote } from '@simplexd/finance';
import { quoteRejectSchema, uuidSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { financeContext } from '@/server/finance/runtime';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

/** POST /api/v1/quotes/:id/reject — customer (or staff on their behalf) rejects the issued quote with a reason. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const { rt, fa } = await financeContext(req, ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, quoteRejectSchema);
  return json(await rejectQuote(rt, fa, id, body), { correlationId: ctx.correlationId });
});
