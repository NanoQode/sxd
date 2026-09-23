import { z } from 'zod';
import { freshnessPolicyUpsertSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { upsertFreshnessPolicy } from '@/server/admin/market-data/policies';

export const dynamic = 'force-dynamic';

const typeParams = z.object({ dataType: z.string().min(2).max(60) });

/** PUT /api/v1/admin/freshness-policies/:dataType — create or update a freshness window (policy.manage). */
export const PUT = route<{ params: Promise<{ dataType: string }> }>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { dataType } = await params(ctx, typeParams);
  const body = await parseJson(req, freshnessPolicyUpsertSchema);
  return json(await upsertFreshnessPolicy(admin, dataType, body), { correlationId: ctx.correlationId });
});
