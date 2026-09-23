import { z } from 'zod';
import { uuidSchema } from '@simplexd/contracts';
import { requireStaff } from '@/lib/auth/session';
import { json, params, route } from '@/lib/api/respond';
import { viewerFromIdentity } from '@/server/appointments/access';
import { retryCalendarSync } from '@/server/appointments/mutate';

export const dynamic = 'force-dynamic';

const idSchema = z.object({ id: uuidSchema });

/**
 * POST /api/v1/appointments/:id/retry-sync — re-run a failed calendar sync or
 * ask Google for a new Meet conference after a failed one (new request id).
 */
export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await requireStaff('appointments.manage_all');
  const { id } = await params(ctx, idSchema);
  return json(
    await retryCalendarSync(viewerFromIdentity(identity), id, { correlationId: ctx.correlationId }),
    {
      correlationId: ctx.correlationId,
    },
  );
});
