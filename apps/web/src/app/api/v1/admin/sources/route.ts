import { sourceCreateSchema, sourceListQuerySchema } from '@simplexd/contracts';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { createSource, listSources } from '@/server/admin/market-data/sources';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/sources — source registry with observation counts. */
export const GET = route(async (req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  const query = parseQuery(req, sourceListQuerySchema);
  return json({ items: await listSources(ctx, query) }, { correlationId });
});

/** POST /api/v1/admin/sources — register a source with license and use notes (market_data.edit). */
export const POST = route(async (req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  const body = await parseJson(req, sourceCreateSchema);
  return json(await createSource(ctx, body), { status: 201, correlationId });
});
