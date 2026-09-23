import { staffDirectoryQuerySchema } from '@simplexd/contracts';
import { json, parseQuery, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { listStaffDirectory } from '@/server/admin/market-data/research-tasks';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/staff-directory — active staff (id, name, email, roles) for assignment pickers. */
export const GET = route(async (req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  const query = parseQuery(req, staffDirectoryQuerySchema);
  return json({ items: await listStaffDirectory(ctx, query) }, { correlationId });
});
