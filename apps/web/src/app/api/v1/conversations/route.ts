import {
  ApiError,
  conversationCreateSchema,
  conversationListQuerySchema,
} from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import { createConversation, listConversations } from '@/server/conversations/service';
import '@/lib/api/registry/collaboration';

export const dynamic = 'force-dynamic';

/** GET /api/v1/conversations — conversations the caller participates in. */
export const GET = route(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const query = parseQuery(req, conversationListQuerySchema);
  return json(await listConversations(identity, query), { correlationId: ctx.correlationId });
});

/** POST /api/v1/conversations — start a conversation; every participant must already have access. */
export const POST = route(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const body = await parseJson(req, conversationCreateSchema);
  return json(await createConversation(identity, body, { correlationId: ctx.correlationId }), {
    status: 201,
    correlationId: ctx.correlationId,
  });
});
