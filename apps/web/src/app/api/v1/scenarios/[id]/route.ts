import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiError, scenarioUpdateSchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, route } from '@/lib/api/respond';
import { pickPresentKeys } from '@/server/markets/patch';
import {
  deleteScenario,
  getScenario,
  updateScenario,
  type ScenarioUpdate,
} from '@/server/markets/scenarios';
import '@/lib/api/registry/markets';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: uuidSchema });
type Ctx = { params: Promise<unknown> };

/** Validates the patch and applies only the keys the client actually sent. */
async function parsePatch(req: Request): Promise<ScenarioUpdate> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError('validation_failed', 'request body must be valid JSON');
  }
  const patch = pickPresentKeys(raw, scenarioUpdateSchema.parse(raw));
  if (Object.keys(patch).filter((k) => k !== 'expectedUpdatedAt').length === 0) {
    throw new ApiError('validation_failed', 'nothing to update');
  }
  return patch;
}

/** GET /api/v1/scenarios/:id (row-level security decides visibility). */
export const GET = route<Ctx>(async (_req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, paramsSchema);
  return json(await getScenario(id, identity), { correlationId: ctx.correlationId });
});

/** PATCH /api/v1/scenarios/:id with optimistic concurrency (expectedUpdatedAt). */
export const PATCH = route<Ctx>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, paramsSchema);
  const body = await parsePatch(req);
  return json(await updateScenario(id, body, identity, ctx.correlationId), {
    correlationId: ctx.correlationId,
  });
});

/** DELETE /api/v1/scenarios/:id (soft delete; snapshots are retained). */
export const DELETE = route<Ctx>(async (_req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, paramsSchema);
  await deleteScenario(id, identity, ctx.correlationId);
  return new NextResponse(null, { status: 204 });
});
