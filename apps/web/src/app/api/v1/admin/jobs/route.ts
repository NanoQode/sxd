import { adminJobListQuerySchema } from '@simplexd/contracts';
import { json, parseQuery, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { listJobs } from '@/server/admin/operations/jobs';
import '@/lib/api/registry/admin-market-data';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/jobs — jobs by status, newest change first, cursor-paginated; never includes payloads (audit.read or platform.settings.manage). */
export const GET = route(async (req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  const query = parseQuery(req, adminJobListQuerySchema);
  return json(await listJobs(ctx, query), { correlationId });
});
