import { dataPolicyKeySchema, dataPolicyPatchSchema } from '@simplexd/contracts';
import { z } from 'zod';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { patchDataPolicy } from '@/server/admin/market-data/policies';

export const dynamic = 'force-dynamic';

const keyParams = z.object({ key: dataPolicyKeySchema });

/** PATCH /api/v1/admin/data-policies/:key — typed value with reason (policy.manage, MFA). */
export const PATCH = route<{ params: Promise<{ key: string }> }>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { key } = await params(ctx, keyParams);
  const body = await parseJson(req, dataPolicyPatchSchema);
  return json(await patchDataPolicy(admin, key, body), { correlationId: ctx.correlationId });
});
