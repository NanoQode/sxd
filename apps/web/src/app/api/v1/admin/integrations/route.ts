import '@/lib/api/registry/integrations';
import { json, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { listIntegrations } from '@/server/integrations/service';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/integrations — status per provider/environment with masked secrets (integrations.read). */
export const GET = route(async (_req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  return json(await listIntegrations(ctx), { correlationId });
});
