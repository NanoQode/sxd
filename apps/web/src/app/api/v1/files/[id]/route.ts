import { z } from 'zod';
import { ApiError, uuidSchema } from '@simplexd/contracts';
import { json, params, route } from '@/lib/api/respond';
import { getIdentity } from '@/lib/auth/session';
import { getFile } from '@/server/files/queries';
import '@/lib/api/registry/files';

export const dynamic = 'force-dynamic';

/** GET /api/v1/files/:id — metadata and scan status (view access). */
export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  return json(await getFile(identity, id, { correlationId: ctx.correlationId }), { correlationId: ctx.correlationId });
});
