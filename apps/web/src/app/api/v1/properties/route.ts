import { ApiError, propertyCreateSchema, propertyListQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import { createProperty, listProperties } from '@/server/properties/service';
import '@/lib/api/registry/collaboration';

export const dynamic = 'force-dynamic';

/** GET /api/v1/properties — list the caller's properties (staff may scope by organizationId). */
export const GET = route(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const query = parseQuery(req, propertyListQuerySchema);
  return json(await listProperties(identity, query), { correlationId: ctx.correlationId });
});

/** POST /api/v1/properties — create a private property asset. */
export const POST = route(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const body = await parseJson(req, propertyCreateSchema);
  const dto = await createProperty(identity, body, { correlationId: ctx.correlationId });
  return json(dto, { status: 201, correlationId: ctx.correlationId });
});
