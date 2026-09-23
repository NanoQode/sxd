import { z } from 'zod';
import { ApiError, uuidSchema, savedSearchUpdateSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, parseQuery, route } from '@/lib/api/respond';
import '@/lib/api/registry/search-purchase';
import { deleteSavedSearch, getSavedSearch, updateSavedSearch } from '@/server/search/saved-searches';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

async function identityOrThrow() {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  return identity;
}

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, ctx) => {
  const identity = await identityOrThrow();
  const { id } = await params(ctx, idParams);
  return json(await getSavedSearch(identity, id), { correlationId: ctx.correlationId });
});

/** PATCH /api/v1/saved-searches/:id — name, criteria or alerts (expectedUpdatedAt guards concurrency). */
export const PATCH = route<Ctx>(async (req, ctx) => {
  const identity = await identityOrThrow();
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, savedSearchUpdateSchema);
  return json(await updateSavedSearch(identity, id, body, { correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});

export const DELETE = route<Ctx>(async (_req, ctx) => {
  const identity = await identityOrThrow();
  const { id } = await params(ctx, idParams);
  await deleteSavedSearch(identity, id, { correlationId: ctx.correlationId });
  return new Response(null, { status: 204 });
});
