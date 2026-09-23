import { getIdentity } from '@/lib/auth/session';
import { json, params, route } from '@/lib/api/respond';
import { rfqResponseParams } from '@/lib/api/registry/commercial';
import { withdrawRfqResponse } from '@/server/procurement/rfqs';

export const dynamic = 'force-dynamic';

export const POST = route<{ params: Promise<{ id: string; rid: string }> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  const { id, rid } = await params(ctx, rfqResponseParams);
  return json(await withdrawRfqResponse(identity, id, rid, { correlationId: ctx.correlationId }), { correlationId: ctx.correlationId });
});
