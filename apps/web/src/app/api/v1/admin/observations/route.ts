import { observationCreateInputSchema, observationListQuerySchema } from '@simplexd/contracts';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { createObservation, listObservations } from '@/server/admin/market-data/observations';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/observations — review queue with filters (pendingOnly=true for the default queue). */
export const GET = route(async (req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  const query = parseQuery(req, observationListQuerySchema);
  return json(await listObservations(ctx, query), { correlationId });
});

/** POST /api/v1/admin/observations — immutable observation + interpretation v1 + submission review row. */
export const POST = route(async (req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  const body = await parseJson(req, observationCreateInputSchema);
  return json(await createObservation(ctx, body), { status: 201, correlationId });
});
