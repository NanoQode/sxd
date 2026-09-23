import { getIdentity } from '@/lib/auth/session';
import { json, route } from '@/lib/api/respond';
import { marketsGeoJson } from '@/server/markets/queries';
import '@/lib/api/registry/markets';

export const dynamic = 'force-dynamic';

/** GET /api/v1/markets/geojson: published markets only; identical for every caller. */
export const GET = route(async (_req, { correlationId }) => {
  const identity = await getIdentity();
  const collection = await marketsGeoJson(identity);
  return json(collection, { correlationId, headers: { 'cache-control': 'public, max-age=60' } });
});
