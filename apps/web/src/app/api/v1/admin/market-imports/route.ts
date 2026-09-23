import { json, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { listImports } from '@/server/admin/market-data/imports';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/market-imports — import history (market_data.import). */
export const GET = route(async (_req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  return json({ items: await listImports(ctx) }, { correlationId });
});
