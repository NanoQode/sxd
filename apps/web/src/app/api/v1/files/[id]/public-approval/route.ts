import { z } from 'zod';
import { ApiError, filePublicApprovalSchema, uuidSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { getIdentity } from '@/lib/auth/session';
import { setPublicApproval } from '@/server/files/approval';
import '@/lib/api/registry/files';

export const dynamic = 'force-dynamic';

/** POST /api/v1/files/:id/public-approval — staff approve derivatives of a clean image for public use. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, filePublicApprovalSchema);
  return json(await setPublicApproval(identity, id, body, { correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});
