import { priceAnchorCreateSchema } from '@simplexd/contracts';
import { json, parseJson, route } from '@/lib/api/respond';
import '@/lib/api/registry/admin-configuration';
import { requireAdminContext } from '@/server/admin/http';
import { createPriceAnchor, listPriceAnchors } from '@/server/admin/configuration/pricing';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/price-anchors — every package with its live anchor and open proposal (pricing.manage). */
export const GET = route(async (_req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  return json({ items: await listPriceAnchors(ctx) }, { correlationId });
});

/** POST /api/v1/admin/price-anchors — add a package as a draft proposal (pricing.manage). */
export const POST = route(async (req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  const body = await parseJson(req, priceAnchorCreateSchema);
  return json(await createPriceAnchor(ctx, body), { status: 201, correlationId });
});
