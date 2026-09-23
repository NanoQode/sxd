import { z } from 'zod';
import { createQuote, listQuotesForRequest } from '@simplexd/finance';
import { quoteCreateSchema, uuidSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { financeContext } from '@/server/finance/runtime';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

/** GET /api/v1/service-requests/:id/quotes — quotes for the request (staff or the owning organisation). */
export const GET = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const { rt, fa } = await financeContext(req, ctx.correlationId);
  const { id } = await params(ctx, idParams);
  return json(
    { items: await listQuotesForRequest(rt, fa, id) },
    { correlationId: ctx.correlationId },
  );
});

/** POST /api/v1/service-requests/:id/quotes — staff `quotes.issue`: draft a quote from a template or lines. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const { rt, fa } = await financeContext(req, ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, quoteCreateSchema);
  return json(await createQuote(rt, fa, id, body), {
    status: 201,
    correlationId: ctx.correlationId,
  });
});
