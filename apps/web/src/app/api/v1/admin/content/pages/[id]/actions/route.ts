import { z } from 'zod';
import { contentPublishActionSchema, uuidSchema } from '@simplexd/contracts';
import { requireStaff } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { applyContentAction } from '@/server/content/admin';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/admin/content/pages/:id/actions — submit_for_review (content.edit);
 * approve, publish, schedule, unpublish, archive, rollback (content.publish, and
 * never on one's own revision).
 */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await requireStaff('content.edit');
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, contentPublishActionSchema);
  return json(await applyContentAction(identity, id, body, { correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});
