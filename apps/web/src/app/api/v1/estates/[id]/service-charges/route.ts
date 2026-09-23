import { z } from 'zod';
import { ApiError, estateServiceChargeRunSchema, uuidSchema } from '@simplexd/contracts';
import { withIdempotency } from '@/lib/api/idempotency';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { getIdentity } from '@/lib/auth/session';
import { requireFeature } from '@/lib/features';
import { runServiceCharges } from '@/server/rentals/estates';
import { FEATURES } from '@/server/rentals/shared';
import '@/lib/api/registry/rentals';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

/** POST /api/v1/estates/:id/service-charges — staff `estates.manage`; one invoice per active lease (honours Idempotency-Key). */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  requireFeature(identity, FEATURES.estateManagement);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, estateServiceChargeRunSchema);
  return withIdempotency(
    req,
    identity,
    `POST /api/v1/estates/${id}/service-charges`,
    body,
    async () =>
      json(await runServiceCharges(identity, id, body, { correlationId: ctx.correlationId }), {
        status: 201,
        correlationId: ctx.correlationId,
      }),
  );
});
