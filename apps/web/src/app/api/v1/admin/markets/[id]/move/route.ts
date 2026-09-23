import { marketMoveSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { idParams, requireAdminContext } from '@/server/admin/http';
import { moveMarket } from '@/server/admin/market-data/markets';

export const dynamic = 'force-dynamic';

/** POST /api/v1/admin/markets/:id/move — relocate the reference point (validated inside Nigeria). */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, marketMoveSchema);
  return json(await moveMarket(admin, id, body), { correlationId: ctx.correlationId });
});
