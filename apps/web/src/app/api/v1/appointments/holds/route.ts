import { holdCreateSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';
import { clientIp, enforceRateLimit, hashIp } from '@/lib/rate-limit';
import { createHold } from '@/server/appointments/holds';
import { providerBusyLoader } from '@/server/calendar/runtime';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/appointments/holds — reserve a slot for a few minutes. The
 * database exclusion constraint guarantees only one hold per overlapping
 * slot and staff member; losers get `slot_unavailable`.
 */
export const POST = route(async (req, { correlationId }) => {
  const body = await parseJson(req, holdCreateSchema);
  const identity = await getIdentity();
  const ipHash = hashIp(clientIp(req));
  await enforceRateLimit(`hold:ip:${ipHash}`, { windowSeconds: 3600, max: identity.session ? 60 : 20 });
  const hold = await createHold(body, {
    identity: identity.session ? identity : null,
    providerBusy: providerBusyLoader(),
  });
  return json(hold, { status: 201, correlationId });
});
