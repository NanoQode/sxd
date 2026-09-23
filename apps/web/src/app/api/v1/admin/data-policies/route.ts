import { json, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { listDataPolicies, rankEligibleEvidenceCount } from '@/server/admin/market-data/policies';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/data-policies — publication and ranking policy settings plus the rank-eligible evidence count. */
export const GET = route(async (_req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  const [items, rankEligibleEvidence] = await Promise.all([
    listDataPolicies(ctx),
    rankEligibleEvidenceCount(ctx),
  ]);
  return json({ items, rankEligibleEvidence }, { correlationId });
});
