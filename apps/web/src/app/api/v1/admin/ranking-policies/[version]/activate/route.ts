import { z } from 'zod';
import { rankingPolicyActivateSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { activateRankingPolicy } from '@/server/admin/market-data/policies';

export const dynamic = 'force-dynamic';

const versionParams = z.object({ version: z.coerce.number().int().min(1) });

/** POST /api/v1/admin/ranking-policies/:version/activate — validates, retires the previous active policy (policy.manage, MFA). */
export const POST = route<{ params: Promise<{ version: string }> }>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { version } = await params(ctx, versionParams);
  const body = await parseJson(req, rankingPolicyActivateSchema);
  return json(await activateRankingPolicy(admin, version, body), {
    correlationId: ctx.correlationId,
  });
});
