import { getIdentity } from '@/lib/auth/session';
import { json, params, route } from '@/lib/api/respond';
import { commercialIdParams } from '@/lib/api/registry/commercial';
import { createBid, listTenderBids } from '@/server/tenders/bids';

export const dynamic = 'force-dynamic';

export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, commercialIdParams);
  return json({ items: await listTenderBids(identity, id, { correlationId: ctx.correlationId }) }, { correlationId: ctx.correlationId });
});

export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, commercialIdParams);
  return json(await createBid(identity, id, { correlationId: ctx.correlationId }), { status: 201, correlationId: ctx.correlationId });
});
