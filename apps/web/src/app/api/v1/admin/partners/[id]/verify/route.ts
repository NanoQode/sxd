import { partnerVerifySchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { verifyPartner } from '@/server/admin/access/partners';
import { idParams, requireAdminContext } from '@/server/admin/http';

export const dynamic = 'force-dynamic';

/** POST /api/v1/admin/partners/:id/verify — verify or reject with the scope of what was checked. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, partnerVerifySchema);
  return json(await verifyPartner(admin, id, body), { correlationId: ctx.correlationId });
});
