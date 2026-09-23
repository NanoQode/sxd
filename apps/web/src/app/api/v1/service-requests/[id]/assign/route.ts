import { z } from 'zod';
import { assignServiceRequest } from '@simplexd/finance';
import { assignRequestSchema, uuidSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { financeContext } from '@/server/finance/runtime';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

/** POST /api/v1/service-requests/:id/assign — staff `service_requests.assign`: (re)assign the project manager; optionally start work. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const { rt, fa } = await financeContext(req, ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, assignRequestSchema);
  return json(await assignServiceRequest(rt, fa, id, body), { correlationId: ctx.correlationId });
});
