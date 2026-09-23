import { z } from 'zod';
import { ApiError, scenarioShareRequestSchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, route } from '@/lib/api/respond';
import { shareScenario } from '@/server/markets/scenarios';
import '@/lib/api/registry/markets';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: uuidSchema });

/** The body is optional: an empty body means the default expiry. */
async function parseOptionalBody(
  req: Request,
): Promise<z.infer<typeof scenarioShareRequestSchema>> {
  const text = await req.text();
  if (text.trim() === '') return scenarioShareRequestSchema.parse({});
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ApiError('validation_failed', 'request body must be valid JSON');
  }
  return scenarioShareRequestSchema.parse(raw);
}

/** POST /api/v1/scenarios/:id/share: creates an expiring private share token (account required). */
export const POST = route<{ params: Promise<unknown> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, paramsSchema);
  const body = await parseOptionalBody(req);
  return json(await shareScenario(id, body, identity, ctx.correlationId), {
    correlationId: ctx.correlationId,
  });
});
