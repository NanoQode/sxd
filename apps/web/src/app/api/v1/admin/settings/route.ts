import { json, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { listSettings } from '@/server/admin/platform/settings';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/settings — whitelisted, typed settings (platform.settings.manage). */
export const GET = route(async (_req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  return json({ items: await listSettings(ctx) }, { correlationId });
});
