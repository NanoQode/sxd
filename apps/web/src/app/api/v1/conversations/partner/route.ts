import { partnerConversationCreateSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';
import { startPartnerConversation } from '@/server/conversations/partner';
import '@/lib/api/registry/partner-ops';

export const dynamic = 'force-dynamic';

/** POST /api/v1/conversations/partner — a partner opens a thread with the SimplexD team about their work. */
export const POST = route(async (req, ctx) => {
  const identity = await getIdentity();
  const body = await parseJson(req, partnerConversationCreateSchema);
  return json(
    await startPartnerConversation(identity, body, { correlationId: ctx.correlationId }),
    { status: 201, correlationId: ctx.correlationId },
  );
});
