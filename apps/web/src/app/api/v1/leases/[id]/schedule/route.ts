import { z } from 'zod';
import { ApiError, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, route } from '@/lib/api/respond';
import { listSchedule } from '@/server/rentals/schedules';
import '@/lib/api/registry/rentals';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });
export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, idParams);
  return json({ items: await listSchedule(identity, id) }, { correlationId: ctx.correlationId });
});
