import { z } from 'zod';
import { templateUpdateSchema, uuidSchema } from '@simplexd/contracts';
import { getDb } from '@simplexd/db';
import { getTemplate, updateTemplate } from '@simplexd/notifications';
import { requireStaff } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { adminCall } from '../../_lib';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

/** GET /api/v1/admin/notifications/templates/:id */
export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  await requireStaff('notifications.templates.manage');
  const { id } = await params(ctx, idParams);
  return json(await adminCall(() => getTemplate(getDb(), id)), {
    correlationId: ctx.correlationId,
  });
});

/** PATCH /api/v1/admin/notifications/templates/:id — edit a draft (approved versions are immutable). */
export const PATCH = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await requireStaff('notifications.templates.manage');
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, templateUpdateSchema);
  const updated = await adminCall(() =>
    updateTemplate(getDb(), id, body, {
      userId: identity.session!.user.id,
      correlationId: ctx.correlationId,
    }),
  );
  return json(updated, { correlationId: ctx.correlationId });
});
