import { leadListQuerySchema } from '@simplexd/contracts';
import { requireStaff } from '@/lib/auth/session';
import { json, parseQuery, route } from '@/lib/api/respond';
import { listLeads } from '@/server/leads/admin';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/leads — cursor-paginated list with status/assignee/search filters (leads.read). */
export const GET = route(async (req, { correlationId }) => {
  const identity = await requireStaff('leads.read');
  const query = parseQuery(req, leadListQuerySchema);
  return json(await listLeads(identity, query), { correlationId });
});
