import { marketRollbackSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { idParams, requireAdminContext } from '@/server/admin/http';
import { rollbackMarket } from '@/server/admin/market-data/markets';

export const dynamic = 'force-dynamic';

/** POST /api/v1/admin/markets/:id/rollback — restore a revision's content as a new revision (audited). */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, marketRollbackSchema);
  return json(await rollbackMarket(admin, id, body), { correlationId: ctx.correlationId });
});
