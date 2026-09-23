import { neighborhoodCreateSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { idParams, requireAdminContext } from '@/server/admin/http';
import { createNeighborhood, listNeighborhoods } from '@/server/admin/market-data/neighborhoods';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/v1/admin/markets/:id/neighborhoods — neighborhoods with boundaries as GeoJSON. */
export const GET = route<Ctx>(async (_req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  return json({ items: await listNeighborhoods(admin, id) }, { correlationId: ctx.correlationId });
});

/** POST /api/v1/admin/markets/:id/neighborhoods — create under a stable market id; boundary validated by PostGIS. */
export const POST = route<Ctx>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, neighborhoodCreateSchema);
  return json(await createNeighborhood(admin, id, body), { status: 201, correlationId: ctx.correlationId });
});
