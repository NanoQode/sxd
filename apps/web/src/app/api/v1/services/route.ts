import { json, route } from '@/lib/api/respond';
import '@/lib/api/registry/public';
import { listServiceCatalog, toPublicServiceDto } from '@/server/services/catalog';

export const dynamic = 'force-dynamic';

/** Public catalogue used by the header search and integrations. */
export const GET = route(async (_req, { correlationId }) => {
  const catalog = await listServiceCatalog();
  return json(
    {
      items: [...catalog.core, ...catalog.planned].map(toPublicServiceDto),
      generatedAt: catalog.generatedAt,
    },
    {
      correlationId,
      headers: { 'cache-control': 'public, max-age=60, stale-while-revalidate=300' },
    },
  );
});
