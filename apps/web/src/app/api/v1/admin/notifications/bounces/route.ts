import { bounceImportSchema } from '@simplexd/contracts';
import { requireStaff } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';
import { adminContext } from '@/server/admin/context';
import { recordBounce } from '@/server/admin/communications/service';

export const dynamic = 'force-dynamic';

/** POST /api/v1/admin/notifications/bounces — manual bounce/complaint import until a provider feedback webhook exists (audited). */
export const POST = route(async (req, { correlationId }) => {
  const identity = await requireStaff('notifications.templates.manage');
  const body = await parseJson(req, bounceImportSchema);
  const result = await recordBounce(adminContext(identity, correlationId), body);
  return json(result, { correlationId });
});
