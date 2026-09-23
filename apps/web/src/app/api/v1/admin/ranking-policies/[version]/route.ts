import { z } from 'zod';
import { rankingPolicyPatchSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { getRankingPolicy, patchRankingPolicyDraft } from '@/server/admin/market-data/policies';

export const dynamic = 'force-dynamic';

const versionParams = z.object({ version: z.coerce.number().int().min(1) });
type Ctx = { params: Promise<{ version: string }> };

/** GET /api/v1/admin/ranking-policies/:version */
export const GET = route<Ctx>(async (_req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { version } = await params(ctx, versionParams);
  return json(await getRankingPolicy(admin, version), { correlationId: ctx.correlationId });
});

/** PATCH /api/v1/admin/ranking-policies/:version — edit a draft; errors are returned, activation blocks on them. */
export const PATCH = route<Ctx>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { version } = await params(ctx, versionParams);
  const body = await parseJson(req, rankingPolicyPatchSchema);
  return json(await patchRankingPolicyDraft(admin, version, body), { correlationId: ctx.correlationId });
});
