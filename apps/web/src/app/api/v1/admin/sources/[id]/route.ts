import { sourcePatchSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { idParams, requireAdminContext } from '@/server/admin/http';
import { getSource, patchSource } from '@/server/admin/market-data/sources';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/v1/admin/sources/:id */
export const GET = route<Ctx>(async (_req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  return json(await getSource(admin, id), { correlationId: ctx.correlationId });
});

/** PATCH /api/v1/admin/sources/:id — edit metadata (slug is stable). */
export const PATCH = route<Ctx>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, sourcePatchSchema);
  return json(await patchSource(admin, id, body), { correlationId: ctx.correlationId });
});
