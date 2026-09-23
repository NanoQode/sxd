import { ApiError, savedSearchCreateSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';
import '@/lib/api/registry/search-purchase';
import { createSavedSearch, listSavedSearches } from '@/server/search/saved-searches';

export const dynamic = 'force-dynamic';

async function identityOrThrow() {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  return identity;
}

/** GET /api/v1/saved-searches — the caller's saved searches in the active organisation. */
export const GET = route(async () => {
  const identity = await identityOrThrow();
  return json({ items: await listSavedSearches(identity) });
});

/** POST /api/v1/saved-searches — save search criteria, optionally with alerts. */
export const POST = route(async (req, ctx) => {
  const identity = await identityOrThrow();
  const body = await parseJson(req, savedSearchCreateSchema);
  const dto = await createSavedSearch(identity, body, { correlationId: ctx.correlationId });
  return json(dto, { status: 201, correlationId: ctx.correlationId });
});
