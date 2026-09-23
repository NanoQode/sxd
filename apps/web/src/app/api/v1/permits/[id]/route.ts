import { z } from 'zod';
import { permitUpdateSchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { getPermit, updatePermit } from '@/server/projects/permits';

export const dynamic = 'force-dynamic';

export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  return json(await getPermit(identity, id), { status: 200, correlationId: ctx.correlationId });
});

export const PATCH = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, permitUpdateSchema);
  return json(await updatePermit(identity, id, body, { correlationId: ctx.correlationId }), {
    status: 200,
    correlationId: ctx.correlationId,
  });
});
