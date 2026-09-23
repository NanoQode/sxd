import { featureFlagPatchSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { keyParams, requireAdminContext } from '@/server/admin/http';
import { patchFeatureFlag } from '@/server/admin/platform/feature-flags';

export const dynamic = 'force-dynamic';

/** PATCH /api/v1/admin/feature-flags/:key — toggle; review flags need a reason, regulated flags need the key typed. */
export const PATCH = route<{ params: Promise<{ key: string }> }>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { key } = await params(ctx, keyParams);
  const body = await parseJson(req, featureFlagPatchSchema);
  return json(await patchFeatureFlag(admin, key, body), { correlationId: ctx.correlationId });
});
