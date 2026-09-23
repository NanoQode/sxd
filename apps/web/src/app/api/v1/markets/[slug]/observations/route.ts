import { z } from 'zod';
import { ApiError, marketObservationsQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseQuery, route } from '@/lib/api/respond';
import { listMarketObservations } from '@/server/markets/queries';
import '@/lib/api/registry/markets';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ slug: z.string().min(1).max(120) });

/** GET /api/v1/markets/:idOrSlug/observations?cursor=&limit=&scope= */
export const GET = route<{ params: Promise<unknown> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { slug } = await params(ctx, paramsSchema);
  const query = parseQuery(req, marketObservationsQuerySchema);
  const page = await listMarketObservations(slug, query, identity);
  if (!page) throw new ApiError('not_found', 'market not found');
  return json(page, { correlationId: ctx.correlationId });
});
