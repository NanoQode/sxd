import { json, route } from '@/lib/api/respond';
import { parseListingFilters } from '@/server/listings/filters';
import { listPublishedListings } from '@/server/listings/public';
import '@/lib/api/registry/listings';

export const dynamic = 'force-dynamic';

/** GET /api/v1/public/listings — published, non-duplicate, in-window listings with filters. */
export const GET = route(async (req, { correlationId }) => {
  const { filters, ignored } = parseListingFilters(new URL(req.url).searchParams);
  const items = await listPublishedListings(filters);
  return json(
    { items, filters, ignoredParams: ignored },
    { correlationId, headers: { 'cache-control': 'public, max-age=60' } },
  );
});
