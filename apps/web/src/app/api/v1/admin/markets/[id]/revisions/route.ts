import { revisionCompareQuerySchema } from '@simplexd/contracts';
import { json, params, parseQuery, route } from '@/lib/api/respond';
import { idParams, requireAdminContext } from '@/server/admin/http';
import { compareRevisions, listRevisions } from '@/server/admin/market-data/markets';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/markets/:id/revisions[?compare=a,b] — revision history or a side-by-side diff. */
export const GET = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const { compare } = parseQuery(req, revisionCompareQuerySchema);
  if (compare) {
    const [a, b] = compare.split(',').map(Number) as [number, number];
    return json(await compareRevisions(admin, id, a, b), { correlationId: ctx.correlationId });
  }
  return json({ items: await listRevisions(admin, id) }, { correlationId: ctx.correlationId });
});
