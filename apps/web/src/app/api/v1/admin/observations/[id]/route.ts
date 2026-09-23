import { json, params, route } from '@/lib/api/respond';
import { idParams, requireAdminContext } from '@/server/admin/http';
import { getObservation } from '@/server/admin/market-data/observations';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/observations/:id — observation, interpretation history, reviews and comparables. */
export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  return json(await getObservation(admin, id), { correlationId: ctx.correlationId });
});
