import { z } from 'zod';
import { ApiError, uuidSchema, estateServiceChargeRunSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { runServiceCharges } from '@/server/rentals/estates';
import '@/lib/api/registry/rentals';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, estateServiceChargeRunSchema);
  return json(await runServiceCharges(identity, id, body, { correlationId: ctx.correlationId }), { status: 201, correlationId: ctx.correlationId });
});
