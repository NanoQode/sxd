import { z } from 'zod';
import { notificationChannelSchema } from '@simplexd/contracts';
import { requireStaff } from '@/lib/auth/session';
import { json, parseQuery, route } from '@/lib/api/respond';
import '@/lib/api/registry/communications';
import { adminContext } from '@/server/admin/context';
import { listTemplateCatalog } from '@/server/admin/communications/service';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  channel: notificationChannelSchema.optional(),
  search: z.string().trim().max(64).optional(),
});

/** GET /api/v1/admin/notifications/templates/families — one row per key × channel × locale with the active version. */
export const GET = route(async (req, { correlationId }) => {
  const identity = await requireStaff('notifications.templates.manage');
  const query = parseQuery(req, querySchema);
  const items = await listTemplateCatalog(adminContext(identity, correlationId), query);
  return json({ items }, { correlationId });
});
