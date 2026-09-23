import { z } from 'zod';
import { ApiError, uuidSchema } from '@simplexd/contracts';
import { getDb } from '@simplexd/db';
import { markNotificationRead } from '@simplexd/notifications';
import { getIdentity } from '@/lib/auth/session';
import { json, params, route } from '@/lib/api/respond';

export const dynamic = 'force-dynamic';

/** POST /api/v1/notifications/:id/read — marks one of the caller's notifications read (idempotent). */
export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const updated = await markNotificationRead(getDb(), identity.ctx, id);
  if (!updated) throw new ApiError('not_found', 'notification not found');
  return json(updated, { correlationId: ctx.correlationId });
});
