import { ApiError, ownerStatementGenerateSchema, ownerStatementListQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import { generateOwnerStatement, listOwnerStatements } from '@/server/rentals/owner-statements';
import '@/lib/api/registry/rentals';

export const dynamic = 'force-dynamic';
export const GET = route(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  return json(await listOwnerStatements(identity, parseQuery(req, ownerStatementListQuerySchema)), { correlationId: ctx.correlationId });
});

/** POST /api/v1/owner-statements — staff `rentals.manage`: generate (or regenerate the draft of) a period statement. */
export const POST = route(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const body = await parseJson(req, ownerStatementGenerateSchema);
  return json(await generateOwnerStatement(identity, body, { correlationId: ctx.correlationId }), { status: 201, correlationId: ctx.correlationId });
});
