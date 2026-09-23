import { z } from 'zod';
import { ApiError, uuidSchema, assetUpdateSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { requireFeature } from '@/lib/features';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { getAsset, updateAsset } from '@/server/maintenance/assets';
import { FEATURES } from '@/server/rentals/shared';
import '@/lib/api/registry/rentals';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });
export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  requireFeature(identity, FEATURES.preventiveMaintenance);
  const { id } = await params(ctx, idParams);
  return json(await getAsset(identity, id), { correlationId: ctx.correlationId });
});

export const PATCH = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  requireFeature(identity, FEATURES.preventiveMaintenance);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, assetUpdateSchema);
  return json(await updateAsset(identity, id, body, { correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});
