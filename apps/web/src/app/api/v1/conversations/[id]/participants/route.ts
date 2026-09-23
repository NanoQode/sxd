import { z } from 'zod';
import { ApiError, uuidSchema, conversationParticipantAddSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { addParticipant } from '@/server/conversations/service';
import '@/lib/api/registry/collaboration';

export const dynamic = 'force-dynamic';

/** POST /api/v1/conversations/:id/participants — staff or the creator add a participant who already has access. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, conversationParticipantAddSchema);
  return json(await addParticipant(identity, id, body, { correlationId: ctx.correlationId }), {
    status: 201,
    correlationId: ctx.correlationId,
  });
});
