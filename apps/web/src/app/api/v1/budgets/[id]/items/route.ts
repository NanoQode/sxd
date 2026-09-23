import { z } from 'zod';
import { boqItemsReplaceSchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { replaceBoqItems } from '@/server/projects/budgets';

export const dynamic = 'force-dynamic';

export const PUT = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, boqItemsReplaceSchema);
  return json(await replaceBoqItems(identity, id, body, { correlationId: ctx.correlationId }), {
    status: 200,
    correlationId: ctx.correlationId,
  });
});
