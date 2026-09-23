import { z } from 'zod';
import { issueCreditNote } from '@simplexd/finance';
import { creditNoteCreateSchema, uuidSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { financeContext } from '@/server/finance/runtime';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

/** POST /api/v1/invoices/:id/credit-notes — staff `finance.invoices.manage`: credit note applied to the balance. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const { rt, fa } = await financeContext(req, ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, creditNoteCreateSchema);
  return json(await issueCreditNote(rt, fa, id, body), {
    status: 201,
    correlationId: ctx.correlationId,
  });
});
