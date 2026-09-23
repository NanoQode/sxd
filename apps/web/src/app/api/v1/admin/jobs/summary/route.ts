import { json, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { queueSummary } from '@/server/admin/operations/jobs';
import '@/lib/api/registry/admin-market-data';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/jobs/summary — queue depth, dead jobs and stuck outbox events (audit.read or platform.settings.manage). */
export const GET = route(async (_req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  return json(await queueSummary(ctx), { correlationId });
});
