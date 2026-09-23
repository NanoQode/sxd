import { settingPatchSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { keyParams, requireAdminContext } from '@/server/admin/http';
import { patchSetting } from '@/server/admin/platform/settings';

export const dynamic = 'force-dynamic';

/** PATCH /api/v1/admin/settings/:key — value validated against the key's type. */
export const PATCH = route<{ params: Promise<{ key: string }> }>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { key } = await params(ctx, keyParams);
  const body = await parseJson(req, settingPatchSchema);
  return json(await patchSetting(admin, key, body), { correlationId: ctx.correlationId });
});
