import { z } from 'zod';
import { contentRevisionCreateSchema, uuidSchema } from '@simplexd/contracts';
import { requireStaff } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { createContentRevision, getContentPageDetail } from '@/server/content/admin';

export const dynamic = 'force-dynamic';

const idSchema = z.object({ id: uuidSchema });

/** GET /api/v1/admin/content/pages/:id/revisions — revision history, newest first. */
export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await requireStaff('content.edit');
  const { id } = await params(ctx, idSchema);
  const detail = await getContentPageDetail(identity, id);
  return json({ items: detail.revisions }, { correlationId: ctx.correlationId });
});

/** POST /api/v1/admin/content/pages/:id/revisions — save a new draft revision (content.edit). */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await requireStaff('content.edit');
  const { id } = await params(ctx, idSchema);
  const body = await parseJson(req, contentRevisionCreateSchema);
  return json(
    await createContentRevision(identity, id, body, { correlationId: ctx.correlationId }),
    {
      status: 201,
      correlationId: ctx.correlationId,
    },
  );
});
