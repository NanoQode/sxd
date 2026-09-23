import { z } from 'zod';
import { siteVisitSubmitSchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { submitSiteVisit } from '@/server/projects/site-visits';

export const dynamic = 'force-dynamic';

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, siteVisitSubmitSchema);
  const result = await submitSiteVisit(identity, id, body, { correlationId: ctx.correlationId });
  return json(result, { status: result.idempotentReplay ? 200 : 201, correlationId: ctx.correlationId });
});
