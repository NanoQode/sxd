import { marketFlagCreateSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { idParams, requireAdminContext } from '@/server/admin/http';
import { createFlag, listFlags } from '@/server/admin/market-data/flags';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/v1/admin/markets/:id/flags */
export const GET = route<Ctx>(async (_req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  return json({ items: await listFlags(admin, id) }, { correlationId: ctx.correlationId });
});

/** POST /api/v1/admin/markets/:id/flags — exclusions/stops need the approver; advisories need edit. */
export const POST = route<Ctx>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, marketFlagCreateSchema);
  return json(await createFlag(admin, id, body), { status: 201, correlationId: ctx.correlationId });
});
