import { z } from 'zod';
import { ApiError } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, route } from '@/lib/api/respond';
import { getMarketBySlug } from '@/server/markets/queries';
import '@/lib/api/registry/markets';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ slug: z.string().min(1).max(120) });

/** GET /api/v1/markets/:slug (a UUID is accepted as well). */
export const GET = route<{ params: Promise<unknown> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  const { slug } = await params(ctx, paramsSchema);
  const market = await getMarketBySlug(slug, identity);
  if (!market) throw new ApiError('not_found', 'market not found');
  return json(market, { correlationId: ctx.correlationId });
});
