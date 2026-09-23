import { deliveryLogQuerySchema } from '@simplexd/contracts';
import { requireStaff } from '@/lib/auth/session';
import { json, parseQuery, route } from '@/lib/api/respond';
import '@/lib/api/registry/communications';
import { adminContext } from '@/server/admin/context';
import { deliveryLog } from '@/server/admin/communications/service';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/admin/notifications/deliveries — delivery log with masked
 * recipients, real provider statuses, a status timeline, sanitised errors and
 * whether a failed attempt can be retried. Recipient filter is an exact match.
 */
export const GET = route(async (req, { correlationId }) => {
  const identity = await requireStaff('notifications.templates.manage');
  const query = parseQuery(req, deliveryLogQuerySchema);
  return json(await deliveryLog(adminContext(identity, correlationId), query), { correlationId });
});
