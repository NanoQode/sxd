import { contentListQuerySchema, contentPageCreateSchema } from '@simplexd/contracts';
import { requireStaff } from '@/lib/auth/session';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import { createContentPage, listContentPages } from '@/server/content/admin';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/content/pages — list with kind/status/search filters (content.edit). */
export const GET = route(async (req, { correlationId }) => {
  const identity = await requireStaff('content.edit');
  const query = parseQuery(req, contentListQuerySchema);
  return json(await listContentPages(identity, query), { correlationId });
});

/** POST /api/v1/admin/content/pages — create a draft page with revision 1 (content.edit). */
export const POST = route(async (req, { correlationId }) => {
  const identity = await requireStaff('content.edit');
  const body = await parseJson(req, contentPageCreateSchema);
  return json(await createContentPage(identity, body, { correlationId }), {
    status: 201,
    correlationId,
  });
});
