import { suppressionListQuerySchema } from '@simplexd/contracts';
import { requireStaff } from '@/lib/auth/session';
import { json, parseQuery, route } from '@/lib/api/respond';
import '@/lib/api/registry/communications';
import { adminContext } from '@/server/admin/context';
import { suppressionList } from '@/server/admin/communications/service';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/notifications/suppressions — STOP replies, hard bounces and complaints (masked addresses). */
export const GET = route(async (req, { correlationId }) => {
  const identity = await requireStaff('notifications.templates.manage');
  const query = parseQuery(req, suppressionListQuerySchema);
  return json(await suppressionList(adminContext(identity, correlationId), query), {
    correlationId,
  });
});
