import { z } from 'zod';
import { contentPagePatchSchema, uuidSchema } from '@simplexd/contracts';
import { requireStaff } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { getContentPageDetail, updateContentPageMeta } from '@/server/content/admin';

export const dynamic = 'force-dynamic';

const idSchema = z.object({ id: uuidSchema });

/** GET /api/v1/admin/content/pages/:id — page with its revisions. */
export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await requireStaff('content.edit');
  const { id } = await params(ctx, idSchema);
  return json(await getContentPageDetail(identity, id), { correlationId: ctx.correlationId });
});

/** PATCH /api/v1/admin/content/pages/:id — SEO and ordering with expectedVersion. */
export const PATCH = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await requireStaff('content.edit');
  const { id } = await params(ctx, idSchema);
  const body = await parseJson(req, contentPagePatchSchema);
  return json(await updateContentPageMeta(identity, id, body, { correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});
