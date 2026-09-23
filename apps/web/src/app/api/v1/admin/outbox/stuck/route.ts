import { stuckOutboxQuerySchema } from '@simplexd/contracts';
import { json, parseQuery, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { listStuckOutbox } from '@/server/admin/operations/jobs';
import '@/lib/api/registry/admin-market-data';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/outbox/stuck — unpublished events the relay skips (attempts at the threshold) with a count; never includes payloads. */
export const GET = route(async (req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  const { limit } = parseQuery(req, stuckOutboxQuerySchema);
  return json(await listStuckOutbox(ctx, limit), { correlationId });
});
