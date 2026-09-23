import { z } from 'zod';
import { ApiError, uuidSchema, shortlistItemUpdateSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, parseQuery, route } from '@/lib/api/respond';
import '@/lib/api/registry/search-purchase';
import { updateShortlistItem } from '@/server/search/shortlists';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

async function identityOrThrow() {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  return identity;
}

/** PATCH /api/v1/shortlist-items/:id — staff edit notes, order, status or an external entry's details. */
export const PATCH = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await identityOrThrow();
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, shortlistItemUpdateSchema);
  return json(await updateShortlistItem(identity, id, body, { correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});
