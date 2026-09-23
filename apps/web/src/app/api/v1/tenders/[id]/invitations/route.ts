import { tenderInviteSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { commercialIdParams } from '@/lib/api/registry/commercial';
import { inviteTenderPartners, listTenderInvitations } from '@/server/tenders/tenders';

export const dynamic = 'force-dynamic';

export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, commercialIdParams);
  return json(
    { items: await listTenderInvitations(identity, id, { correlationId: ctx.correlationId }) },
    { correlationId: ctx.correlationId },
  );
});

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, commercialIdParams);
  const body = await parseJson(req, tenderInviteSchema);
  return json(
    { items: await inviteTenderPartners(identity, id, body, { correlationId: ctx.correlationId }) },
    { correlationId: ctx.correlationId },
  );
});
