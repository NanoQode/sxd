import { z } from 'zod';
import { ApiError, uuidSchema, handoverAcknowledgeSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import '@/lib/api/registry/search-purchase';
import { acknowledgeHandover } from '@/server/purchase/closing';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

async function identityOrThrow() {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  return identity;
}

/** POST /api/v1/purchase-items/:id/acknowledge — the customer acknowledges receipt of a handover document. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await identityOrThrow();
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, handoverAcknowledgeSchema);
  return json(await acknowledgeHandover(identity, id, body, { correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});
