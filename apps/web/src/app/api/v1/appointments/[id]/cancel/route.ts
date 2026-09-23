import { z } from 'zod';
import { cancelSchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { viewerFromIdentity } from '@/server/appointments/access';
import { cancelAppointment } from '@/server/appointments/mutate';

export const dynamic = 'force-dynamic';

const idSchema = z.object({ id: uuidSchema });

/** POST /api/v1/appointments/:id/cancel — cancel with a reason; releases capacity and the calendar event. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const viewer = viewerFromIdentity(identity);
  const { id } = await params(ctx, idSchema);
  const body = await parseJson(req, cancelSchema);
  return json(
    await cancelAppointment({ kind: 'id', viewer, id }, body, { correlationId: ctx.correlationId }),
    { correlationId: ctx.correlationId },
  );
});
