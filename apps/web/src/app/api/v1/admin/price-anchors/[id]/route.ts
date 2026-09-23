import { json, params, route } from '@/lib/api/respond';
import { idParams, requireAdminContext } from '@/server/admin/http';
import { getPriceAnchor } from '@/server/admin/configuration/pricing';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/v1/admin/price-anchors/:id — anchor with its full revision history. */
export const GET = route<Ctx>(async (_req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  return json(await getPriceAnchor(admin, id), { correlationId: ctx.correlationId });
});
