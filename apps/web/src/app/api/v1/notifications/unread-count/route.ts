import { ApiError } from '@simplexd/contracts';
import { getDb } from '@simplexd/db';
import { unreadCount } from '@simplexd/notifications';
import { getIdentity } from '@/lib/auth/session';
import { json, route } from '@/lib/api/respond';

export const dynamic = 'force-dynamic';

/** GET /api/v1/notifications/unread-count — badge count for the signed-in user. */
export const GET = route(async (_req, { correlationId }) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  return json({ unreadCount: await unreadCount(getDb(), identity.ctx) }, { correlationId });
});
