import { adminMarketListQuerySchema, marketUpsertSchema } from '@simplexd/contracts';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { createMarket, listMarkets } from '@/server/admin/market-data/markets';
import '@/lib/api/registry/admin-market-data';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/markets — markets including drafts, with filters and pagination (market_data.read_drafts). */
export const GET = route(async (req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  const query = parseQuery(req, adminMarketListQuerySchema);
  return json(await listMarkets(ctx, query), { correlationId });
});

/** POST /api/v1/admin/markets — create a draft market (market_data.edit). */
export const POST = route(async (req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  const body = await parseJson(req, marketUpsertSchema);
  return json(await createMarket(ctx, body), { status: 201, correlationId });
});
