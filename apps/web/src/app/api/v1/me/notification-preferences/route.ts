import { ApiError, notificationPreferencesUpdateSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';
import {
  getNotificationPreferences,
  updateNotificationPreferences,
} from '@/server/portal/notification-preferences';

export const dynamic = 'force-dynamic';

/** GET /api/v1/me/notification-preferences — channel x category matrix, digest and quiet hours. */
export const GET = route(async (_req, { correlationId }) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  return json(await getNotificationPreferences(identity), { correlationId });
});

/** PUT /api/v1/me/notification-preferences — replaces the matrix; security stays on by policy. */
export const PUT = route(async (req, { correlationId }) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const body = await parseJson(req, notificationPreferencesUpdateSchema);
  return json(await updateNotificationPreferences(identity, body), { correlationId });
});
