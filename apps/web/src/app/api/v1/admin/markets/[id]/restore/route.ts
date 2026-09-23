import { marketTransitionSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { idParams, requireAdminContext } from '@/server/admin/http';
import { transitionMarket } from '@/server/admin/market-data/markets';

export const dynamic = 'force-dynamic';

/** POST /api/v1/admin/markets/:id/restore — archived market back to draft. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, marketTransitionSchema);
  return json(await transitionMarket(admin, id, 'restore', body), {
    correlationId: ctx.correlationId,
  });
});
