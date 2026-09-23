import { redirectUpsertSchema } from '@simplexd/contracts';
import { requireStaff } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';
import { createRedirect, listRedirects } from '@/server/content/redirects';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/redirects — all redirects (content.edit). */
export const GET = route(async (_req, { correlationId }) => {
  const identity = await requireStaff('content.edit');
  return json({ items: await listRedirects(identity) }, { correlationId });
});

/** POST /api/v1/admin/redirects — create a redirect (content.publish). */
export const POST = route(async (req, { correlationId }) => {
  const identity = await requireStaff('content.publish');
  const body = await parseJson(req, redirectUpsertSchema);
  return json(await createRedirect(identity, body, { correlationId }), {
    status: 201,
    correlationId,
  });
});
