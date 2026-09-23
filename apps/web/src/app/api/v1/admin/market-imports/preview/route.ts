import { importPreviewRequestSchema } from '@simplexd/contracts';
import { json, parseJson, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { previewImport } from '@/server/admin/market-data/imports';

export const dynamic = 'force-dynamic';

/** POST /api/v1/admin/market-imports/preview — dry-run a seed JSON or observations CSV; nothing is written. */
export const POST = route(async (req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  const body = await parseJson(req, importPreviewRequestSchema);
  return json(await previewImport(ctx, body), { status: 201, correlationId });
});
