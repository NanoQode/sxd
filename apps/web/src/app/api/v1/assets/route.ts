import { ApiError, assetCreateSchema, assetListQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { requireFeature } from '@/lib/features';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import { createAsset, listAssets } from '@/server/maintenance/assets';
import { FEATURES } from '@/server/rentals/shared';
import '@/lib/api/registry/rentals';

export const dynamic = 'force-dynamic';
export const GET = route(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  requireFeature(identity, FEATURES.preventiveMaintenance);
  return json(await listAssets(identity, parseQuery(req, assetListQuerySchema)), {
    correlationId: ctx.correlationId,
  });
});

export const POST = route(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  requireFeature(identity, FEATURES.preventiveMaintenance);
  const body = await parseJson(req, assetCreateSchema);
  return json(await createAsset(identity, body, { correlationId: ctx.correlationId }), {
    status: 201,
    correlationId: ctx.correlationId,
  });
});
