import { researchTaskCreateSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { idParams, requireAdminContext } from '@/server/admin/http';
import { createResearchTask, listResearchTasks } from '@/server/admin/market-data/research-tasks';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/v1/admin/markets/:id/research-tasks */
export const GET = route<Ctx>(async (_req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  return json({ items: await listResearchTasks(admin, id) }, { correlationId: ctx.correlationId });
});

/** POST /api/v1/admin/markets/:id/research-tasks — researcher and reviewer must differ. */
export const POST = route<Ctx>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, researchTaskCreateSchema);
  return json(await createResearchTask(admin, id, body), { status: 201, correlationId: ctx.correlationId });
});
