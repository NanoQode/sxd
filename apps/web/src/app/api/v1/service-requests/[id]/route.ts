import { z } from 'zod';
import { ApiError, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, route } from '@/lib/api/respond';
import { getServiceRequestDetail } from '@/server/requests/queries';

export const dynamic = 'force-dynamic';

/** GET /api/v1/service-requests/:id — detail with status timeline and customer-visible notes. */
export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  return json(await getServiceRequestDetail(identity, id), { correlationId: ctx.correlationId });
});
