import { ApiError, phoneUpdateSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';
import { updatePhone } from '@/server/portal/profile';

export const dynamic = 'force-dynamic';

/** PATCH /api/v1/me/phone — validates with libphonenumber-js and stores E.164 (null clears). */
export const PATCH = route(async (req, { correlationId }) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const body = await parseJson(req, phoneUpdateSchema);
  return json(await updatePhone(identity, body), { correlationId });
});
