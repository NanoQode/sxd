import { z } from 'zod';
import { ApiError, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { requireFeature } from '@/lib/features';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { attachProperty } from '@/server/rentals/estates';
import { FEATURES } from '@/server/rentals/shared';
import '@/lib/api/registry/rentals';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  requireFeature(identity, FEATURES.estateManagement);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, z.object({ propertyId: uuidSchema }));
  return json(
    await attachProperty(identity, id, body.propertyId, { correlationId: ctx.correlationId }),
    { correlationId: ctx.correlationId },
  );
});
