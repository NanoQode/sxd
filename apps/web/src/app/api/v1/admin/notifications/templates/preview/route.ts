import { samplePreviewSchema } from '@simplexd/contracts';
import { requireStaff } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';
import '@/lib/api/registry/communications';
import { adminContext } from '@/server/admin/context';
import { previewTemplateWithSamples } from '@/server/admin/communications/service';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/admin/notifications/templates/preview — render a stored version or
 * unsaved content on the server with catalogue sample values (plus optional
 * staff-typed overrides). Never reads customer records. SMS previews include
 * encoding, segments and the estimated cost at the configured Termii price.
 */
export const POST = route(async (req, { correlationId }) => {
  const identity = await requireStaff('notifications.templates.manage');
  const body = await parseJson(req, samplePreviewSchema);
  const preview = await previewTemplateWithSamples(adminContext(identity, correlationId), body);
  return json(preview, { correlationId });
});
