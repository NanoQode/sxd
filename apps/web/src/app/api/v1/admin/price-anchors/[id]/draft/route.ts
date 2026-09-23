import { priceAnchorDraftSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { idParams, requireAdminContext } from '@/server/admin/http';
import { savePriceAnchorDraft } from '@/server/admin/configuration/pricing';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/v1/admin/price-anchors/:id/draft — save a proposed change as a new draft revision. */
export const POST = route<Ctx>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, priceAnchorDraftSchema);
  return json(await savePriceAnchorDraft(admin, id, body), { correlationId: ctx.correlationId });
});
