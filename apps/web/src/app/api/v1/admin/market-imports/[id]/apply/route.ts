import { importApplySchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { idParams, requireAdminContext } from '@/server/admin/http';
import { applyImport } from '@/server/admin/market-data/imports';

export const dynamic = 'force-dynamic';

/** POST /api/v1/admin/market-imports/:id/apply — apply a previewed import; human edits are never overwritten. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, importApplySchema);
  return json(await applyImport(admin, id, body), { correlationId: ctx.correlationId });
});
