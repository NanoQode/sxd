import { z } from 'zod';
import { ApiError, estateCreateSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { requireFeature } from '@/lib/features';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import { createEstate, listEstates } from '@/server/rentals/estates';
import { FEATURES } from '@/server/rentals/shared';
import '@/lib/api/registry/rentals';

export const dynamic = 'force-dynamic';
export const GET = route(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  requireFeature(identity, FEATURES.estateManagement);
  const query = parseQuery(req, z.object({ organizationId: z.string().min(1).max(64).optional() }));
  return json({ items: await listEstates(identity, query) }, { correlationId: ctx.correlationId });
});

export const POST = route(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  requireFeature(identity, FEATURES.estateManagement);
  const body = await parseJson(req, estateCreateSchema);
  return json(await createEstate(identity, body, { correlationId: ctx.correlationId }), {
    status: 201,
    correlationId: ctx.correlationId,
  });
});
