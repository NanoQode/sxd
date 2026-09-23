import { z } from 'zod';
import { addQuoteVersion } from '@simplexd/finance';
import { quoteVersionCreateSchema, uuidSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { financeContext } from '@/server/finance/runtime';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

/** POST /api/v1/quotes/:id/versions — staff `quotes.issue`: a new version supersedes the current one. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const { rt, fa } = await financeContext(req, ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, quoteVersionCreateSchema);
  return json(await addQuoteVersion(rt, fa, id, body), {
    status: 201,
    correlationId: ctx.correlationId,
  });
});
