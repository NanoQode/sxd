import { z } from 'zod';
import { ApiError, uuidSchema, workOrderApproveSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { approveWorkOrder } from '@/server/maintenance/work-orders';
import '@/lib/api/registry/rentals';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, workOrderApproveSchema);
  return json(await approveWorkOrder(identity, id, body, { correlationId: ctx.correlationId }), {
    status: 200,
    correlationId: ctx.correlationId,
  });
});
