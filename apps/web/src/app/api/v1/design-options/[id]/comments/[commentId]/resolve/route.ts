import { z } from 'zod';
import { uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, route } from '@/lib/api/respond';
import { resolveDesignComment } from '@/server/projects/design';

export const dynamic = 'force-dynamic';

export const POST = route<{ params: Promise<{ id: string; commentId: string }> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  const { id, commentId } = await params(ctx, z.object({ id: uuidSchema, commentId: uuidSchema }));
  return json(await resolveDesignComment(identity, id, commentId, { correlationId: ctx.correlationId }), { status: 200, correlationId: ctx.correlationId });
});
