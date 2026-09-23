import { integrationTestSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { providerParams } from '@/server/integrations/http';
import { testIntegration } from '@/server/integrations/service';

export const dynamic = 'force-dynamic';

/** POST /api/v1/admin/integrations/:provider/test — runs the real adapter check on a saved version (integrations.test). */
export const POST = route<{ params: Promise<{ provider: string }> }>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { provider } = await params(ctx, providerParams);
  const body = await parseJson(req, integrationTestSchema);
  return json(await testIntegration(admin, provider, body), { correlationId: ctx.correlationId });
});
