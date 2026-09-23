import { slaPolicyCreateSchema } from '@simplexd/contracts';
import { json, parseJson, route } from '@/lib/api/respond';
import '@/lib/api/registry/admin-configuration';
import { requireAdminContext } from '@/server/admin/http';
import { createSlaPolicy, listSlaPolicies } from '@/server/admin/configuration/sla-policies';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/sla-policies — targets per stage per service (sla.manage or service_requests.read_all). */
export const GET = route(async (_req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  return json({ items: await listSlaPolicies(ctx) }, { correlationId });
});

/** POST /api/v1/admin/sla-policies — add a policy; one active per service and stage (sla.manage). */
export const POST = route(async (req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  const body = await parseJson(req, slaPolicyCreateSchema);
  return json(await createSlaPolicy(ctx, body), { status: 201, correlationId });
});
