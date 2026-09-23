import { z } from 'zod';
import { ApiError, fileGrantCreateSchema, uuidSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { getIdentity } from '@/lib/auth/session';
import { createGrant, listGrants } from '@/server/files/grants';
import '@/lib/api/registry/files';

export const dynamic = 'force-dynamic';

const idParams = z.object({ id: uuidSchema });

/** GET /api/v1/files/:id/grants — grants on a file (owner or staff). */
export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, idParams);
  return json({ items: await listGrants(identity, id, { correlationId: ctx.correlationId }) }, { correlationId: ctx.correlationId });
});

/** POST /api/v1/files/:id/grants — grant a user or organisation view/download access. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, fileGrantCreateSchema);
  return json(await createGrant(identity, id, body, { correlationId: ctx.correlationId }), {
    status: 201,
    correlationId: ctx.correlationId,
  });
});
