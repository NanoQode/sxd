import { rankingPolicyCreateSchema } from '@simplexd/contracts';
import { json, parseJson, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { createRankingPolicyDraft, listRankingPolicies } from '@/server/admin/market-data/policies';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/ranking-policies — every version with validation errors. */
export const GET = route(async (_req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  return json({ items: await listRankingPolicies(ctx) }, { correlationId });
});

/** POST /api/v1/admin/ranking-policies — new draft copied from the active (or given) version. */
export const POST = route(async (req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  const body = await parseJson(req, rankingPolicyCreateSchema);
  return json(await createRankingPolicyDraft(ctx, body), { status: 201, correlationId });
});
