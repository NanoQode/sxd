import { z } from 'zod';
import { issueQuote } from '@simplexd/finance';
import { quoteIssueSchema, uuidSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { financeContext } from '@/server/finance/runtime';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

/** POST /api/v1/quotes/:id/issue — staff `quotes.issue`: quote → issued, engagement → quoted. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const { rt, fa } = await financeContext(req, ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, quoteIssueSchema);
  return json(await issueQuote(rt, fa, id, body), { correlationId: ctx.correlationId });
});
