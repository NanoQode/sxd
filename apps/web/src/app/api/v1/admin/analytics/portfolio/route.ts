import { portfolioAnalyticsQuerySchema } from '@simplexd/contracts';
import { json, parseQuery, route } from '@/lib/api/respond';
import '@/lib/api/registry/admin-configuration';
import { requireAdminContext } from '@/server/admin/http';
import { portfolioAnalytics } from '@/server/admin/analytics/portfolio';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/analytics/portfolio — counts and sums derived from records; sections the actor may see. */
export const GET = route(async (req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  const query = parseQuery(req, portfolioAnalyticsQuerySchema);
  return json(await portfolioAnalytics(ctx, query), { correlationId });
});
