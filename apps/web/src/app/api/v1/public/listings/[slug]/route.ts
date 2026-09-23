import { z } from 'zod';
import { ApiError, slugSchema } from '@simplexd/contracts';
import { json, params, route } from '@/lib/api/respond';
import { getPublicListingState } from '@/server/listings/public';
import '@/lib/api/registry/listings';

export const dynamic = 'force-dynamic';

/** GET /api/v1/public/listings/:slug — a live listing, or why it is no longer available. */
export const GET = route<{ params: Promise<{ slug: string }> }>(async (req, ctx) => {
  const { slug } = await params(ctx, z.object({ slug: slugSchema }));
  const state = await getPublicListingState(slug);
  if (state.state === 'not_found') throw new ApiError('not_found', 'listing not found');
  return json(state, {
    correlationId: ctx.correlationId,
    status: state.state === 'unavailable' ? 410 : 200,
    headers: { 'cache-control': 'public, max-age=60' },
  });
});
