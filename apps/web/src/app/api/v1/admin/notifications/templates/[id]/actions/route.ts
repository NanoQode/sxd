import { z } from 'zod';
import { templateActionSchema, uuidSchema } from '@simplexd/contracts';
import { getDb } from '@simplexd/db';
import { applyTemplateAction } from '@simplexd/notifications';
import { requireStaff } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { adminCall } from '../../../_lib';

export const dynamic = 'force-dynamic';

/** POST /api/v1/admin/notifications/templates/:id/actions — approve, retire or reopen a version. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await requireStaff('notifications.templates.manage');
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, templateActionSchema);
  const updated = await adminCall(() =>
    applyTemplateAction(getDb(), id, body.action, {
      userId: identity.session!.user.id,
      correlationId: ctx.correlationId,
    }),
  );
  return json(updated, { correlationId: ctx.correlationId });
});
