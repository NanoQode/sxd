import { z } from 'zod';
import { scheduleReplaceSchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { getSchedule, replaceSchedule } from '@/server/projects/schedule';

export const dynamic = 'force-dynamic';

export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  return json(await getSchedule(identity, id), { status: 200, correlationId: ctx.correlationId });
});

export const PUT = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, scheduleReplaceSchema);
  return json(await replaceSchedule(identity, id, body, { correlationId: ctx.correlationId }), {
    status: 200,
    correlationId: ctx.correlationId,
  });
});
