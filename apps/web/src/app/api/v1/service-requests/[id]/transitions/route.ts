import { z } from 'zod';
import { ApiError, serviceRequestTransitionSchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { applyCustomerTransition } from '@/server/requests/transition';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/service-requests/:id/transitions — customer transitions only
 * (cancel with reason, pause with reason, resume). Staff move requests through
 * the triage, assignment and quotation endpoints beside this one.
 */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, serviceRequestTransitionSchema);
  const updated = await applyCustomerTransition(identity, id, body, {
    correlationId: ctx.correlationId,
  });
  return json(updated, { correlationId: ctx.correlationId });
});
