import { createHash } from 'node:crypto';
import { appointmentListQuerySchema, bookingCreateSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { withIdempotency } from '@/lib/api/idempotency';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import { clientIp, enforceRateLimit, hashIp } from '@/lib/rate-limit';
import { viewerFromIdentity } from '@/server/appointments/access';
import { createBooking } from '@/server/appointments/book';
import { listAppointments } from '@/server/appointments/queries';

export const dynamic = 'force-dynamic';

/** GET /api/v1/appointments — staff calendar/list, customer list, partner/inspector own visits. */
export const GET = route(async (req, { correlationId }) => {
  const identity = await getIdentity();
  const viewer = viewerFromIdentity(identity);
  const query = parseQuery(req, appointmentListQuerySchema);
  return json(await listAppointments(viewer, query), { correlationId });
});

/** POST /api/v1/appointments — convert a hold into an appointment (idempotent). */
export const POST = route(async (req, { correlationId }) => {
  const body = await parseJson(req, bookingCreateSchema);
  const identity = await getIdentity();
  const ipHash = hashIp(clientIp(req));
  await enforceRateLimit(`booking:ip:${ipHash}`, { windowSeconds: 3600, max: identity.session ? 30 : 5 });
  if (!identity.session && body.guest) {
    const emailHash = createHash('sha256').update(body.guest.email.toLowerCase()).digest('hex').slice(0, 24);
    await enforceRateLimit(`booking:email:${emailHash}`, { windowSeconds: 3600, max: 3 });
  }
  return withIdempotency(req, identity, 'POST /api/v1/appointments', body, async () => {
    const appointment = await createBooking(body, {
      identity: identity.session ? identity : null,
      correlationId,
    });
    return json(appointment, { status: 201, correlationId });
  });
});
