import { availabilityQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseQuery, route } from '@/lib/api/respond';
import { clientIp, enforceRateLimit, hashIp } from '@/lib/rate-limit';
import { computeAvailability } from '@/server/appointments/availability';
import { providerBusyLoader } from '@/server/calendar/runtime';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/appointments/availability?kind=&staffUserId=&from=&to=&tz=
 * Public for guest-bookable kinds (rate limited per hashed IP); other kinds
 * need a session. Slots are UTC instants with business/customer labels.
 */
export const GET = route(async (req, { correlationId }) => {
  const query = parseQuery(req, availabilityQuerySchema);
  const identity = await getIdentity();
  const ipHash = hashIp(clientIp(req));
  await enforceRateLimit(`availability:ip:${ipHash}`, { windowSeconds: 60, max: identity.session ? 120 : 60 });
  const result = await computeAvailability({
    kind: query.kind,
    staffUserId: query.staffUserId,
    from: new Date(query.from),
    to: new Date(query.to),
    customerTimeZone: query.tz,
    providerBusy: providerBusyLoader(),
  });
  if (!identity.session && !isGuestKind(query.kind)) {
    return json({ ...result, slots: [], unavailableReason: 'kind_not_bookable' as const }, { correlationId });
  }
  return json(result, { correlationId });
});

function isGuestKind(kind: string): boolean {
  return kind === 'consultation';
}
