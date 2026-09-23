import { templatePreviewSchema } from '@simplexd/contracts';
import { getDb } from '@simplexd/db';
import { previewNotificationTemplate } from '@simplexd/notifications';
import { requireStaff } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';
import { adminCall, pipelineOptions } from '../../_lib';

export const dynamic = 'force-dynamic';

/** POST /api/v1/admin/notifications/templates/preview — render a stored or inline template with sample data. */
export const POST = route(async (req, { correlationId }) => {
  await requireStaff('notifications.templates.manage');
  const body = await parseJson(req, templatePreviewSchema);
  const preview = await adminCall(() =>
    previewNotificationTemplate(getDb(), body, pipelineOptions()),
  );
  return json(preview, { correlationId });
});
