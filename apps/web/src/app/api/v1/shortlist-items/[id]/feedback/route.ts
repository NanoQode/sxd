import { z } from 'zod';
import { ApiError, uuidSchema, shortlistItemFeedbackSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import '@/lib/api/registry/search-purchase';
import { giveShortlistFeedback } from '@/server/search/shortlists';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

async function identityOrThrow() {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  return identity;
}

/** POST /api/v1/shortlist-items/:id/feedback — the customer rates an entry or marks a preference. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await identityOrThrow();
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, shortlistItemFeedbackSchema);
  return json(
    await giveShortlistFeedback(identity, id, body, { correlationId: ctx.correlationId }),
    {
      correlationId: ctx.correlationId,
    },
  );
});
