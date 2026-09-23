import { z } from 'zod';
import { scheduleTaskActualsSchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { recordTaskActuals } from '@/server/projects/schedule';

export const dynamic = 'force-dynamic';

export const PATCH = route<{ params: Promise<{ id: string; key: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id, key } = await params(
    ctx,
    z.object({ id: uuidSchema, key: z.string().min(1).max(64) }),
  );
  const body = await parseJson(req, scheduleTaskActualsSchema);
  return json(
    await recordTaskActuals(identity, id, key, body, { correlationId: ctx.correlationId }),
    { status: 200, correlationId: ctx.correlationId },
  );
});
