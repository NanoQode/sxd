import { auditListQuerySchema } from '@simplexd/contracts';
import { json, parseQuery, route } from '@/lib/api/respond';
import { listAuditEvents } from '@/server/admin/audit/list';
import { requireAdminContext } from '@/server/admin/http';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/audit — read-only, cursor-paginated audit log with actor/entity/action/date filters (audit.read). */
export const GET = route(async (req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  const query = parseQuery(req, auditListQuerySchema);
  return json(await listAuditEvents(ctx, query), { correlationId });
});
