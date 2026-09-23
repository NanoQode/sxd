import { json, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { listFreshnessPolicies } from '@/server/admin/market-data/policies';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/freshness-policies */
export const GET = route(async (_req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  return json({ items: await listFreshnessPolicies(ctx) }, { correlationId });
});
