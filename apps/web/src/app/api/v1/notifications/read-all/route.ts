import { ApiError } from '@simplexd/contracts';
import { getDb } from '@simplexd/db';
import { markAllNotificationsRead } from '@simplexd/notifications';
import { getIdentity } from '@/lib/auth/session';
import { json, route } from '@/lib/api/respond';

export const dynamic = 'force-dynamic';

/** POST /api/v1/notifications/read-all — marks every unread notification of the caller read. */
export const POST = route(async (_req, { correlationId }) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const marked = await markAllNotificationsRead(getDb(), identity.ctx);
  return json({ marked }, { correlationId });
});
