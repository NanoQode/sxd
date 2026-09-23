import { json, route } from '@/lib/api/respond';
import { listPartnerQueue } from '@/server/admin/access/partners';
import { requireAdminContext } from '@/server/admin/http';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/partners — partner verification queue (access.partners.verify). */
export const GET = route(async (_req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  return json({ items: await listPartnerQueue(ctx) }, { correlationId });
});
