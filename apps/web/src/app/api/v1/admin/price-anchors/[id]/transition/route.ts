import { priceAnchorTransitionSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { idParams, requireAdminContext } from '@/server/admin/http';
import { transitionPriceAnchor } from '@/server/admin/configuration/pricing';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/v1/admin/price-anchors/:id/transition — submit, publish (different approver, MFA), reject or withdraw. */
export const POST = route<Ctx>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, priceAnchorTransitionSchema);
  return json(await transitionPriceAnchor(admin, id, body), { correlationId: ctx.correlationId });
});
