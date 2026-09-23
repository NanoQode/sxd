import { json, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { listFeatureFlags } from '@/server/admin/platform/feature-flags';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/feature-flags (platform.feature_flags.manage) */
export const GET = route(async (_req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  return json({ items: await listFeatureFlags(ctx) }, { correlationId });
});
