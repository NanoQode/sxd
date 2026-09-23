import { z } from 'zod';
import { redirectPatchSchema, uuidSchema } from '@simplexd/contracts';
import { requireStaff } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { patchRedirect } from '@/server/content/redirects';

export const dynamic = 'force-dynamic';

/** PATCH /api/v1/admin/redirects/:id — toggle or edit a redirect (content.publish). */
export const PATCH = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await requireStaff('content.publish');
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, redirectPatchSchema);
  return json(await patchRedirect(identity, id, body, { correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});
