import { z } from 'zod';
import { ApiError, uuidSchema, shortlistCreateSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import '@/lib/api/registry/search-purchase';
import { createShortlist } from '@/server/search/shortlists';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

async function identityOrThrow() {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  return identity;
}

/** POST /api/v1/service-requests/:id/shortlists — staff start a shortlist for the engagement. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await identityOrThrow();
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, shortlistCreateSchema);
  const dto = await createShortlist(identity, id, body, { correlationId: ctx.correlationId });
  return json(dto, { status: 201, correlationId: ctx.correlationId });
});
