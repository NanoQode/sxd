import { z } from 'zod';
import {
  engagementItemCreateSchema,
  engagementItemListQuerySchema,
  uuidSchema,
} from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, parseQuery, route } from '@/lib/api/respond';
import { createEngagementItem, listEngagementItems } from '@/server/engagements/items';
import '@/lib/api/registry/diligence';

export const dynamic = 'force-dynamic';

/** GET /api/v1/service-requests/:id/engagement-items — records the caller may see. */
export const GET = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const query = parseQuery(req, engagementItemListQuerySchema);
  return json(await listEngagementItems(identity, id, query), {
    correlationId: ctx.correlationId,
  });
});

/** POST /api/v1/service-requests/:id/engagement-items — staff managing the request. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, engagementItemCreateSchema);
  return json(
    await createEngagementItem(identity, id, body, { correlationId: ctx.correlationId }),
    { status: 201, correlationId: ctx.correlationId },
  );
});
