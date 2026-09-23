import { z } from 'zod';
import { budgetVersionCreateSchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { createBudgetVersion, listBudgetVersions } from '@/server/projects/budgets';

export const dynamic = 'force-dynamic';

export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  return json(await listBudgetVersions(identity, id), { status: 200, correlationId: ctx.correlationId });
});

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, budgetVersionCreateSchema);
  return json(await createBudgetVersion(identity, id, body, { correlationId: ctx.correlationId }), { status: 201, correlationId: ctx.correlationId });
});
