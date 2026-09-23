import { listReconciliationAttempts } from '@simplexd/finance';
import { reconciliationAttemptsQuerySchema } from '@simplexd/contracts';
import { json, parseQuery, route } from '@/lib/api/respond';
import { financeContext } from '@/server/finance/runtime';

export const dynamic = 'force-dynamic';

/** GET /api/v1/finance/reconciliation/attempts — staff `finance.reconcile`: attempts pending, uncertain or reversed. */
export const GET = route(async (req, { correlationId }) => {
  const { rt, fa } = await financeContext(req, correlationId);
  const query = parseQuery(req, reconciliationAttemptsQuerySchema);
  return json({ items: await listReconciliationAttempts(rt, fa, { status: query.status, environment: query.environment, limit: query.limit }) }, { correlationId });
});
