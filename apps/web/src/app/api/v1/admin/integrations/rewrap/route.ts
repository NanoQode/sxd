import { json, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { requestRewrap } from '@/server/integrations/service';

export const dynamic = 'force-dynamic';

/** POST /api/v1/admin/integrations/rewrap — enqueues `integrations.rewrap_secrets` (integrations.secrets.rotate, MFA). */
export const POST = route(async (_req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  return json(await requestRewrap(ctx), { status: 202, correlationId });
});
