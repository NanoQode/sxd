import { z } from 'zod';
import { json, params, route } from '@/lib/api/respond';
import { clientIp, enforceRateLimit, hashIp } from '@/lib/rate-limit';
import { getAppointmentByManageToken } from '@/server/appointments/queries';

export const dynamic = 'force-dynamic';

const tokenSchema = z.object({ token: z.string().min(16).max(128) });

/** GET /api/v1/appointments/manage/:token — guest view through the manage link. */
export const GET = route<{ params: Promise<{ token: string }> }>(async (req, ctx) => {
  await enforceRateLimit(`manage:ip:${hashIp(clientIp(req))}`, { windowSeconds: 60, max: 30 });
  const { token } = await params(ctx, tokenSchema);
  return json(await getAppointmentByManageToken(token), { correlationId: ctx.correlationId });
});
