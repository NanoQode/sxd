import { priceAnchorRetireSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { idParams, requireAdminContext } from '@/server/admin/http';
import { retirePriceAnchor } from '@/server/admin/configuration/pricing';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/v1/admin/price-anchors/:id/retire — take a package off the public site (MFA, reason). */
export const POST = route<Ctx>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, priceAnchorRetireSchema);
  return json(await retirePriceAnchor(admin, id, body), { correlationId: ctx.correlationId });
});
