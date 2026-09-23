import { slaPolicyPatchSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { idParams, requireAdminContext } from '@/server/admin/http';
import { patchSlaPolicy } from '@/server/admin/configuration/sla-policies';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/v1/admin/sla-policies/:id — change target, calendar, escalation role or activity (reason). */
export const PATCH = route<Ctx>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, slaPolicyPatchSchema);
  return json(await patchSlaPolicy(admin, id, body), { correlationId: ctx.correlationId });
});
