import { z } from 'zod';
import { ApiError, uuidSchema, purchaseItemCreateSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, parseQuery, route } from '@/lib/api/respond';
import '@/lib/api/registry/search-purchase';
import { createPurchaseItem } from '@/server/purchase/closing';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

async function identityOrThrow() {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  return identity;
}

/** POST /api/v1/service-requests/:id/purchase/items — staff add a condition, closing task or handover document. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await identityOrThrow();
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, purchaseItemCreateSchema);
  const dto = await createPurchaseItem(identity, id, body, { correlationId: ctx.correlationId });
  return json(dto, { status: 201, correlationId: ctx.correlationId });
});
