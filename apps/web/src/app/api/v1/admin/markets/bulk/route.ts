import { marketBulkActionSchema } from '@simplexd/contracts';
import { json, parseJson, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { bulkMarkets } from '@/server/admin/market-data/markets';

export const dynamic = 'force-dynamic';

/** POST /api/v1/admin/markets/bulk — preview or apply publish/unpublish for many markets (market_data.publish). */
export const POST = route(async (req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  const body = await parseJson(req, marketBulkActionSchema);
  return json(await bulkMarkets(ctx, body), { correlationId });
});
