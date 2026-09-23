import { observationReviewInputSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { idParams, requireAdminContext } from '@/server/admin/http';
import { reviewObservation } from '@/server/admin/market-data/observations';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/admin/observations/:id/review — approve/reject/dispute/mark_stale/
 * publish/unpublish/mark_rank_eligible/mark_rank_ineligible. Publish and rank
 * eligibility need market_data.publish (MFA) by someone other than the submitter.
 */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, observationReviewInputSchema);
  return json(await reviewObservation(admin, id, body), { correlationId: ctx.correlationId });
});
