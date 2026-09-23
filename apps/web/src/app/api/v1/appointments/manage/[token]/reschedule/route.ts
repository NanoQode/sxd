import { z } from 'zod';
import { rescheduleSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { clientIp, enforceRateLimit, hashIp } from '@/lib/rate-limit';
import { rescheduleAppointment } from '@/server/appointments/mutate';

export const dynamic = 'force-dynamic';

const tokenSchema = z.object({ token: z.string().min(16).max(128) });

/** POST /api/v1/appointments/manage/:token/reschedule — guest reschedule onto a fresh hold. */
export const POST = route<{ params: Promise<{ token: string }> }>(async (req, ctx) => {
  await enforceRateLimit(`manage:ip:${hashIp(clientIp(req))}`, { windowSeconds: 60, max: 30 });
  const { token } = await params(ctx, tokenSchema);
  const body = await parseJson(req, rescheduleSchema);
  return json(
    await rescheduleAppointment({ kind: 'token', manageToken: token }, body, { correlationId: ctx.correlationId }),
    { correlationId: ctx.correlationId },
  );
});
