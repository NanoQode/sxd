import { z } from 'zod';
import { getInvoice } from '@simplexd/finance';
import { uuidSchema } from '@simplexd/contracts';
import { json, params, route } from '@/lib/api/respond';
import { financeContext } from '@/server/finance/runtime';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

/** GET /api/v1/invoices/:id — customer `org.invoices.view` or staff `finance.read`. */
export const GET = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const { rt, fa } = await financeContext(req, ctx.correlationId);
  const { id } = await params(ctx, idParams);
  return json(await getInvoice(rt, fa, id), { correlationId: ctx.correlationId });
});
