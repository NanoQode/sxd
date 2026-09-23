import { z } from 'zod';
import { defectTransitionSchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { transitionDefect } from '@/server/projects/defects';

export const dynamic = 'force-dynamic';

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, defectTransitionSchema);
  return json(await transitionDefect(identity, id, body, { correlationId: ctx.correlationId }), { status: 200, correlationId: ctx.correlationId });
});
