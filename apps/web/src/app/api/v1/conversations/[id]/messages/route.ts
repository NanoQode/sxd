import { z } from 'zod';
import {
  ApiError,
  uuidSchema,
  messageCreateSchema,
  messageListQuerySchema,
} from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, parseQuery, route } from '@/lib/api/respond';
import { listMessages, postMessage } from '@/server/conversations/messages';
import '@/lib/api/registry/collaboration';

export const dynamic = 'force-dynamic';

/** GET /api/v1/conversations/:id/messages — newest first, cursor paginated; internal-only messages are staff-only. */
export const GET = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const query = parseQuery(req, messageListQuerySchema);
  return json(await listMessages(identity, id, query), { correlationId: ctx.correlationId });
});

/** POST /api/v1/conversations/:id/messages */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, messageCreateSchema);
  return json(await postMessage(identity, id, body, { correlationId: ctx.correlationId }), {
    status: 201,
    correlationId: ctx.correlationId,
  });
});
