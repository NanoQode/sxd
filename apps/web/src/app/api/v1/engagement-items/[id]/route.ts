import { z } from 'zod';
import { engagementItemUpdateSchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { getEngagementItem, updateEngagementItem } from '@/server/engagements/items';
import '@/lib/api/registry/diligence';

export const dynamic = 'force-dynamic';

/** GET /api/v1/engagement-items/:id */
export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  return json(await getEngagementItem(identity, id), { correlationId: ctx.correlationId });
});

/** PATCH /api/v1/engagement-items/:id — managers (all fields) or the assignee (detail, reference, severity). */
export const PATCH = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, engagementItemUpdateSchema);
  return json(await updateEngagementItem(identity, id, body, { correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});
