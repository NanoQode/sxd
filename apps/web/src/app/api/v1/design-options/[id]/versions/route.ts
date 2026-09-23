import { z } from 'zod';
import { designOptionNewVersionSchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { createDesignOptionVersion } from '@/server/projects/design';

export const dynamic = 'force-dynamic';

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, designOptionNewVersionSchema);
  return json(
    await createDesignOptionVersion(identity, id, body, { correlationId: ctx.correlationId }),
    { status: 201, correlationId: ctx.correlationId },
  );
});
