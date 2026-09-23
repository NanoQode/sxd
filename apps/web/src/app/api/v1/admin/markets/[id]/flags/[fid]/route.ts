import { marketFlagPatchSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { marketChildParams, requireAdminContext } from '@/server/admin/http';
import { patchFlag } from '@/server/admin/market-data/flags';

export const dynamic = 'force-dynamic';

const paramSchema = marketChildParams('fid');

/** PATCH /api/v1/admin/markets/:id/flags/:fid — deactivate or amend a flag with a reason. */
export const PATCH = route<{ params: Promise<{ id: string; fid: string }> }>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const p = (await params(ctx, paramSchema)) as { id: string; fid: string };
  const body = await parseJson(req, marketFlagPatchSchema);
  return json(await patchFlag(admin, p.id, p.fid, body), { correlationId: ctx.correlationId });
});
