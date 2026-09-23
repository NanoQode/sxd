import { z } from 'zod';
import { commitmentCreateSchema, commitmentListQuerySchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, parseQuery, route } from '@/lib/api/respond';
import { addCommitment, listCommitments } from '@/server/projects/budgets';

export const dynamic = 'force-dynamic';

export const GET = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const query = parseQuery(req, commitmentListQuerySchema);
  return json(await listCommitments(identity, id, query), { status: 200, correlationId: ctx.correlationId });
});

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, commitmentCreateSchema);
  return json(await addCommitment(identity, id, body, { correlationId: ctx.correlationId }), { status: 201, correlationId: ctx.correlationId });
});
