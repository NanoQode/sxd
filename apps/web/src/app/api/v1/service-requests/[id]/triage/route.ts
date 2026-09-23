import { z } from 'zod';
import { triageServiceRequest } from '@simplexd/finance';
import { triageRequestSchema, uuidSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { financeContext } from '@/server/finance/runtime';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

/** POST /api/v1/service-requests/:id/triage — staff `service_requests.triage`: inquiry → triage with assignment, priority and SLA. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const { rt, fa } = await financeContext(req, ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, triageRequestSchema);
  return json(await triageServiceRequest(rt, fa, id, body), { correlationId: ctx.correlationId });
});
