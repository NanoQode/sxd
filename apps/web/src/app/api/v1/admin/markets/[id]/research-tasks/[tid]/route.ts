import { researchTaskPatchSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { marketChildParams, requireAdminContext } from '@/server/admin/http';
import { patchResearchTask } from '@/server/admin/market-data/research-tasks';

export const dynamic = 'force-dynamic';

const paramSchema = marketChildParams('tid');

/** PATCH /api/v1/admin/markets/:id/research-tasks/:tid */
export const PATCH = route<{ params: Promise<{ id: string; tid: string }> }>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const p = (await params(ctx, paramSchema)) as { id: string; tid: string };
  const body = await parseJson(req, researchTaskPatchSchema);
  return json(await patchResearchTask(admin, p.id, p.tid, body), { correlationId: ctx.correlationId });
});
