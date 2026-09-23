import { integrationDisableSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { providerParams } from '@/server/integrations/http';
import { disableIntegration } from '@/server/integrations/service';

export const dynamic = 'force-dynamic';

/** POST /api/v1/admin/integrations/:provider/disable — status disabled, is_active false, reason audited. */
export const POST = route<{ params: Promise<{ provider: string }> }>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { provider } = await params(ctx, providerParams);
  const body = await parseJson(req, integrationDisableSchema);
  return json(await disableIntegration(admin, provider, body), {
    correlationId: ctx.correlationId,
  });
});
