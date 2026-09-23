import { z } from 'zod';
import { templateRestoreSchema, uuidSchema } from '@simplexd/contracts';
import { requireStaff } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import '@/lib/api/registry/communications';
import { adminContext } from '@/server/admin/context';
import { restoreTemplate } from '@/server/admin/communications/service';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/admin/notifications/templates/:id/restore — rollback without
 * rewriting history: copies this version into a new version, as a draft or
 * (with `activate`) approved immediately, retiring the current active one.
 */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await requireStaff('notifications.templates.manage');
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, templateRestoreSchema);
  const result = await restoreTemplate(adminContext(identity, ctx.correlationId), id, body);
  return json(result, { status: 201, correlationId: ctx.correlationId });
});
