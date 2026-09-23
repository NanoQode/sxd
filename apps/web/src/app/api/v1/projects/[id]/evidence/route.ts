import { z } from 'zod';
import { evidenceLinkSchema, evidenceListQuerySchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, parseQuery, route } from '@/lib/api/respond';
import { linkEvidence, listEvidence } from '@/server/projects/evidence';

export const dynamic = 'force-dynamic';

export const GET = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const query = parseQuery(req, evidenceListQuerySchema);
  return json(await listEvidence(identity, id, query), { status: 200, correlationId: ctx.correlationId });
});

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, evidenceLinkSchema);
  const result = await linkEvidence(identity, id, body, { correlationId: ctx.correlationId });
  return json(result, { status: result.idempotentReplay ? 200 : 201, correlationId: ctx.correlationId });
});
