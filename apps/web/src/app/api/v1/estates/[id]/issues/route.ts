import { z } from 'zod';
import { ApiError, uuidSchema, workOrderListQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { requireFeature } from '@/lib/features';
import { json, params, parseQuery, route } from '@/lib/api/respond';
import { listWorkOrders } from '@/server/maintenance/work-orders';
import { FEATURES } from '@/server/rentals/shared';
import '@/lib/api/registry/rentals';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });
/** GET /api/v1/estates/:id/issues — resident issues: work orders scoped to the estate. */
export const GET = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  requireFeature(identity, FEATURES.estateManagement);
  const { id } = await params(ctx, idParams);
  const query = parseQuery(req, workOrderListQuerySchema.omit({ estateId: true }));
  return json(await listWorkOrders(identity, { ...query, estateId: id }), {
    correlationId: ctx.correlationId,
  });
});
