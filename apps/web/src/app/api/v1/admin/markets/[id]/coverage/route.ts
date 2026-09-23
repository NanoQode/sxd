import { serviceCoverageUpdateSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { idParams, requireAdminContext } from '@/server/admin/http';
import { listCoverage, updateCoverage } from '@/server/admin/market-data/coverage';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/v1/admin/markets/:id/coverage — per-service availability (independent of publication). */
export const GET = route<Ctx>(async (_req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  return json({ items: await listCoverage(admin, id) }, { correlationId: ctx.correlationId });
});

/** PUT /api/v1/admin/markets/:id/coverage — upsert availability rows (market_data.edit). */
export const PUT = route<Ctx>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, serviceCoverageUpdateSchema);
  return json(
    { items: await updateCoverage(admin, id, body) },
    { correlationId: ctx.correlationId },
  );
});
