import { z } from 'zod';
import { uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, route } from '@/lib/api/respond';
import { removeTimeOff } from '@/server/appointments/staff-availability';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({
  staffUserId: z.string().min(1).max(64),
  reservationId: uuidSchema,
});

/** DELETE — remove a leave/block entry. */
export const DELETE = route<{ params: Promise<unknown> }>(async (_req, ctx) => {
  const { staffUserId, reservationId } = await params(ctx, paramsSchema);
  const identity = await getIdentity();
  return json(
    await removeTimeOff(identity, staffUserId, reservationId, { correlationId: ctx.correlationId }),
    { correlationId: ctx.correlationId },
  );
});
