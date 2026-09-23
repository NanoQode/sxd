import { z } from 'zod';
import { ApiError, uuidSchema, shortlistOutcomeSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import '@/lib/api/registry/search-purchase';
import { recordShortlistOutcome } from '@/server/search/shortlists';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

async function identityOrThrow() {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  return identity;
}

/** POST /api/v1/shortlists/:id/outcome — staff document the search outcome (drafts a search_outcome report). */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await identityOrThrow();
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, shortlistOutcomeSchema);
  return json(
    await recordShortlistOutcome(identity, id, body, { correlationId: ctx.correlationId }),
    {
      correlationId: ctx.correlationId,
    },
  );
});
