import { integrationActivateSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { providerParams } from '@/server/integrations/http';
import { activateIntegration } from '@/server/integrations/service';

export const dynamic = 'force-dynamic';

/** POST /api/v1/admin/integrations/:provider/activate — flips is_active atomically; needs a passed test unless forced with a reason. */
export const POST = route<{ params: Promise<{ provider: string }> }>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { provider } = await params(ctx, providerParams);
  const body = await parseJson(req, integrationActivateSchema);
  return json(await activateIntegration(admin, provider, body), {
    correlationId: ctx.correlationId,
  });
});
