import { z } from 'zod';
import { timeOffCreateSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { addTimeOff } from '@/server/appointments/staff-availability';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ staffUserId: z.string().min(1).max(64) });

/** POST — block a period (leave or block); refused when it overlaps a booking. */
export const POST = route<{ params: Promise<unknown> }>(async (req, ctx) => {
  const { staffUserId } = await params(ctx, paramsSchema);
  const body = await parseJson(req, timeOffCreateSchema);
  const identity = await getIdentity();
  return json(await addTimeOff(identity, staffUserId, body, { correlationId: ctx.correlationId }), {
    status: 201,
    correlationId: ctx.correlationId,
  });
});
