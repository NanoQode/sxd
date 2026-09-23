import { z } from 'zod';
import { ApiError, uuidSchema, userIdSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, route } from '@/lib/api/respond';
import { removeParticipant } from '@/server/conversations/service';
import '@/lib/api/registry/collaboration';

export const dynamic = 'force-dynamic';

/** DELETE /api/v1/conversations/:id/participants/:userId — leave, or remove (staff or creator). */
export const DELETE = route<{ params: Promise<{ id: string; userId: string }> }>(
  async (req, ctx) => {
    const identity = await getIdentity();
    if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
    const { id, userId } = await params(ctx, z.object({ id: uuidSchema, userId: userIdSchema }));
    return json(
      await removeParticipant(identity, id, userId, { correlationId: ctx.correlationId }),
      { correlationId: ctx.correlationId },
    );
  },
);
