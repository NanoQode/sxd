import { marketMergeSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { idParams, requireAdminContext } from '@/server/admin/http';
import { mergeMarket } from '@/server/admin/market-data/markets';

export const dynamic = 'force-dynamic';

/** POST /api/v1/admin/markets/:id/merge — merge this duplicate into targetMarketId, preserving references. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, marketMergeSchema);
  return json(await mergeMarket(admin, id, body), { correlationId: ctx.correlationId });
});
