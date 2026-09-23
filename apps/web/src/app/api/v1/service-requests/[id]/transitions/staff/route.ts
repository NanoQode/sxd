import { z } from 'zod';
import { applyStaffTransition } from '@simplexd/finance';
import { staffTransitionSchema, uuidSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { financeContext } from '@/server/finance/runtime';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

/**
 * POST /api/v1/service-requests/:id/transitions/staff — staff transitions
 * (reject, pause, resume, cancel with a billing consequence, override into
 * in_progress, review/delivery/completion) through the engagement machine.
 */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const { rt, fa } = await financeContext(req, ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, staffTransitionSchema);
  return json(await applyStaffTransition(rt, fa, id, body), { correlationId: ctx.correlationId });
});
