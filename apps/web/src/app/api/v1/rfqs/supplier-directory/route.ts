import { supplierDirectoryQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseQuery, route } from '@/lib/api/respond';
import '@/lib/api/registry/commercial';
import { listSupplierDirectory } from '@/server/procurement/suppliers';

export const dynamic = 'force-dynamic';

export const GET = route(async (req, ctx) => {
  const identity = await getIdentity();
  const query = parseQuery(req, supplierDirectoryQuerySchema);
  return json(await listSupplierDirectory(identity, query, { correlationId: ctx.correlationId }), { correlationId: ctx.correlationId });
});
