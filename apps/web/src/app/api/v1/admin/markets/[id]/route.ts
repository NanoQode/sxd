import { marketPatchSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { idParams, requireAdminContext } from '@/server/admin/http';
import { getMarket, patchMarket } from '@/server/admin/market-data/markets';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/v1/admin/markets/:id — full market record for administration. */
export const GET = route<Ctx>(async (_req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  return json(await getMarket(admin, id), { correlationId: ctx.correlationId });
});

/** PATCH /api/v1/admin/markets/:id — edit with expectedVersion + changeReason; snapshots a revision. */
export const PATCH = route<Ctx>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, marketPatchSchema);
  return json(await patchMarket(admin, id, body), { correlationId: ctx.correlationId });
});
