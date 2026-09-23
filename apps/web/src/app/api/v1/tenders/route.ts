import { tenderCreateSchema, tenderListQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import '@/lib/api/registry/commercial';
import { createTender, listTenders } from '@/server/tenders/tenders';

export const dynamic = 'force-dynamic';

export const GET = route(async (req, ctx) => {
  const identity = await getIdentity();
  const query = parseQuery(req, tenderListQuerySchema);
  return json(await listTenders(identity, query, { correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});

export const POST = route(async (req, ctx) => {
  const identity = await getIdentity();
  const body = await parseJson(req, tenderCreateSchema);
  return json(await createTender(identity, body, { correlationId: ctx.correlationId }), {
    status: 201,
    correlationId: ctx.correlationId,
  });
});
