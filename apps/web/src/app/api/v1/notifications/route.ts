import { ApiError, notificationFeedQuerySchema } from '@simplexd/contracts';
import { getDb } from '@simplexd/db';
import { listNotifications } from '@simplexd/notifications';
import { getIdentity } from '@/lib/auth/session';
import { json, parseQuery, route } from '@/lib/api/respond';

export const dynamic = 'force-dynamic';

/** GET /api/v1/notifications — the signed-in user's in-app feed (cursor paged, newest first). */
export const GET = route(async (req, { correlationId }) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const query = parseQuery(req, notificationFeedQuerySchema);
  const page = await listNotifications(getDb(), identity.ctx, {
    cursor: query.cursor,
    limit: query.limit,
    unreadOnly: query.unreadOnly,
  });
  return json(page, { correlationId });
});
