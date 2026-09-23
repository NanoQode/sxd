import { z } from 'zod';
import { suppressionRemoveSchema, uuidSchema } from '@simplexd/contracts';
import { requireStaff } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import '@/lib/api/registry/communications';
import { adminContext } from '@/server/admin/context';
import { liftSuppression } from '@/server/admin/communications/service';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/admin/notifications/suppressions/:id/remove — lift a suppression
 * with a required reason (audited). Consent recorded by a STOP reply stays.
 */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await requireStaff('notifications.templates.manage');
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, suppressionRemoveSchema);
  const result = await liftSuppression(adminContext(identity, ctx.correlationId), id, body.reason);
  return json(result, { correlationId: ctx.correlationId });
});
