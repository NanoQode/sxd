import { neighborhoodPatchSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { marketChildParams, requireAdminContext } from '@/server/admin/http';
import { patchNeighborhood } from '@/server/admin/market-data/neighborhoods';

export const dynamic = 'force-dynamic';

const paramSchema = marketChildParams('nid');

/** PATCH /api/v1/admin/markets/:id/neighborhoods/:nid — edit or archive (publicationState) with expectedVersion. */
export const PATCH = route<{ params: Promise<{ id: string; nid: string }> }>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const p = (await params(ctx, paramSchema)) as { id: string; nid: string };
  const body = await parseJson(req, neighborhoodPatchSchema);
  return json(await patchNeighborhood(admin, p.id, p.nid, body), { correlationId: ctx.correlationId });
});
