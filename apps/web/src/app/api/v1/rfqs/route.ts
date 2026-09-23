import { rfqCreateSchema, rfqListQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import '@/lib/api/registry/commercial';
import { createRfq, listRfqs } from '@/server/procurement/rfqs';

export const dynamic = 'force-dynamic';

export const GET = route(async (req, ctx) => {
  const identity = await getIdentity();
  const query = parseQuery(req, rfqListQuerySchema);
  return json(await listRfqs(identity, query, { correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});

export const POST = route(async (req, ctx) => {
  const identity = await getIdentity();
  const body = await parseJson(req, rfqCreateSchema);
  return json(await createRfq(identity, body, { correlationId: ctx.correlationId }), {
    status: 201,
    correlationId: ctx.correlationId,
  });
});
