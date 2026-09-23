import { listReconciliationExceptions } from '@simplexd/finance';
import { cursorPaginationQuerySchema } from '@simplexd/contracts';
import { json, parseQuery, route } from '@/lib/api/respond';
import { financeContext } from '@/server/finance/runtime';

export const dynamic = 'force-dynamic';

/** GET /api/v1/finance/reconciliation/exceptions — staff `finance.reconcile`: open exceptions per reconciliation day. */
export const GET = route(async (req, { correlationId }) => {
  const { rt, fa } = await financeContext(req, correlationId);
  const query = parseQuery(req, cursorPaginationQuerySchema);
  return json(
    { items: await listReconciliationExceptions(rt, fa, { limit: query.limit }) },
    { correlationId },
  );
});
