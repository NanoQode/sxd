import { z } from 'zod';
import { availabilityReplaceSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import {
  getStaffAvailability,
  replaceStaffAvailability,
} from '@/server/appointments/staff-availability';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ staffUserId: z.string().min(1).max(64) });

/** GET — working windows and upcoming time off for a staff member or partner. */
export const GET = route<{ params: Promise<unknown> }>(async (_req, ctx) => {
  const { staffUserId } = await params(ctx, paramsSchema);
  const identity = await getIdentity();
  return json(await getStaffAvailability(identity, staffUserId), {
    correlationId: ctx.correlationId,
  });
});

/** PUT — replace the weekly working windows (ISO weekdays, local times, time zone). */
export const PUT = route<{ params: Promise<unknown> }>(async (req, ctx) => {
  const { staffUserId } = await params(ctx, paramsSchema);
  const body = await parseJson(req, availabilityReplaceSchema);
  const identity = await getIdentity();
  return json(
    await replaceStaffAvailability(identity, staffUserId, body, {
      correlationId: ctx.correlationId,
    }),
    { correlationId: ctx.correlationId },
  );
});
