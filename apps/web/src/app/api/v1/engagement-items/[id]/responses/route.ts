import { z } from 'zod';
import { engagementItemResponseCreateSchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { respondToEngagementItem } from '@/server/engagements/items';
import '@/lib/api/registry/diligence';

export const dynamic = 'force-dynamic';

/** POST /api/v1/engagement-items/:id/responses — customer answer or staff/assignee reply. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, engagementItemResponseCreateSchema);
  return json(
    await respondToEngagementItem(identity, id, body, { correlationId: ctx.correlationId }),
    { status: 201, correlationId: ctx.correlationId },
  );
});
