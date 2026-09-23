import { z } from 'zod';
import { uuidSchema } from '@simplexd/contracts';
import { requireStaff } from '@/lib/auth/session';
import { json, params, route } from '@/lib/api/respond';
import { checkConnection } from '@/server/calendar/admin';

export const dynamic = 'force-dynamic';

const idSchema = z.object({ id: uuidSchema });

/** POST /api/v1/admin/calendar/connections/:id/check — live token/calendar check, recorded on the connection. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await requireStaff('appointments.manage_all');
  const { id } = await params(ctx, idSchema);
  return json(await checkConnection(identity, id, { correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});
