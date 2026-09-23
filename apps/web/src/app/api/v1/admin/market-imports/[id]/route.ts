import { json, params, route } from '@/lib/api/respond';
import { idParams, requireAdminContext } from '@/server/admin/http';
import { getImport } from '@/server/admin/market-data/imports';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/market-imports/:id */
export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  return json(await getImport(admin, id), { correlationId: ctx.correlationId });
});
