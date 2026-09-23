import { deliveryAttemptListQuerySchema } from '@simplexd/contracts';
import { getDb } from '@simplexd/db';
import { listDeliveries } from '@simplexd/notifications';
import { requireStaff } from '@/lib/auth/session';
import { json, parseQuery, route } from '@/lib/api/respond';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/notifications/deliveries — delivery log with real provider statuses and sanitised errors. */
export const GET = route(async (req, { correlationId }) => {
  await requireStaff('notifications.templates.manage');
  const query = parseQuery(req, deliveryAttemptListQuerySchema);
  const page = await listDeliveries(getDb(), {
    channel: query.channel,
    status: query.status,
    templateKey: query.templateKey,
    recipient: query.recipient,
    userId: query.userId,
    provider: query.provider,
    testOnly: query.testOnly,
    from: query.from ? new Date(query.from) : undefined,
    to: query.to ? new Date(query.to) : undefined,
    cursor: query.cursor,
    limit: query.limit,
  });
  return json(page, { correlationId });
});
