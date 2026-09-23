import { z } from 'zod';
import { uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, route } from '@/lib/api/respond';
import { viewerFromIdentity } from '@/server/appointments/access';
import { getAppointment } from '@/server/appointments/queries';

export const dynamic = 'force-dynamic';

const idSchema = z.object({ id: uuidSchema });

/** GET /api/v1/appointments/:id — detail for staff, the customer, their organisation or the assigned partner. */
export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  const viewer = viewerFromIdentity(identity);
  const { id } = await params(ctx, idSchema);
  return json(await getAppointment(viewer, id), { correlationId: ctx.correlationId });
});
