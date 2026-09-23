import { json, route } from '@/lib/api/respond';
import { getRedirectSnapshot } from '@/server/content/redirects';
import '@/lib/api/registry/content-public';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/redirects/snapshot — active redirects for the proxy's in-memory
 * table. Public and read-only: the rows are the same public facts the
 * redirects themselves reveal (no ids, notes or hit counts).
 */
export const GET = route(async (_req, { correlationId }) => {
  return json(await getRedirectSnapshot(), {
    correlationId,
    headers: { 'cache-control': 'private, max-age=0, must-revalidate' },
  });
});
