import { z } from 'zod';
import { changeOrderSubmitSchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { submitChangeOrder } from '@/server/projects/change-orders';

export const dynamic = 'force-dynamic';

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, changeOrderSubmitSchema);
  return json(await submitChangeOrder(identity, id, body, { correlationId: ctx.correlationId }), {
    status: 200,
    correlationId: ctx.correlationId,
  });
});
