import { templateCreateSchema, templateListQuerySchema } from '@simplexd/contracts';
import { getDb } from '@simplexd/db';
import { createTemplate, listTemplates } from '@simplexd/notifications';
import { requireStaff } from '@/lib/auth/session';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import { adminCall } from '../_lib';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/notifications/templates — every template version, filterable (notifications.templates.manage). */
export const GET = route(async (req, { correlationId }) => {
  await requireStaff('notifications.templates.manage');
  const query = parseQuery(req, templateListQuerySchema);
  return json({ items: await listTemplates(getDb(), query) }, { correlationId });
});

/** POST /api/v1/admin/notifications/templates — new draft version for a key/channel/locale. */
export const POST = route(async (req, { correlationId }) => {
  const identity = await requireStaff('notifications.templates.manage');
  const body = await parseJson(req, templateCreateSchema);
  const created = await adminCall(() =>
    createTemplate(getDb(), body, { userId: identity.session!.user.id, correlationId }),
  );
  return json(created, { status: 201, correlationId });
});
