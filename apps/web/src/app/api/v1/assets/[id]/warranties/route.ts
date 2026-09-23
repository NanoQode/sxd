import { z } from 'zod';
import { ApiError, uuidSchema, warrantyCreateSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { requireFeature } from '@/lib/features';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { addWarranty } from '@/server/maintenance/assets';
import { FEATURES } from '@/server/rentals/shared';
import '@/lib/api/registry/rentals';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  requireFeature(identity, FEATURES.preventiveMaintenance);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, warrantyCreateSchema);
  return json(await addWarranty(identity, id, body, { correlationId: ctx.correlationId }), {
    status: 201,
    correlationId: ctx.correlationId,
  });
});
