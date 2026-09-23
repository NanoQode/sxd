import { z } from 'zod';
import { rescheduleSchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { withIdempotency } from '@/lib/api/idempotency';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { viewerFromIdentity } from '@/server/appointments/access';
import { rescheduleAppointment } from '@/server/appointments/mutate';

export const dynamic = 'force-dynamic';

const idSchema = z.object({ id: uuidSchema });

/** POST /api/v1/appointments/:id/reschedule — atomic swap onto a fresh hold. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const viewer = viewerFromIdentity(identity);
  const { id } = await params(ctx, idSchema);
  const body = await parseJson(req, rescheduleSchema);
  return withIdempotency(
    req,
    identity,
    `POST /api/v1/appointments/{id}/reschedule`,
    { id, ...body },
    async () =>
      json(
        await rescheduleAppointment({ kind: 'id', viewer, id }, body, {
          correlationId: ctx.correlationId,
        }),
        { correlationId: ctx.correlationId },
      ),
  );
});
