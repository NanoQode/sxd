import { integrationLogsQuerySchema } from '@simplexd/contracts';
import { json, params, parseQuery, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { providerParams } from '@/server/integrations/http';
import { listIntegrationLogs } from '@/server/integrations/service';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/integrations/:provider/logs — sanitized integration log (integrations.read). */
export const GET = route<{ params: Promise<{ provider: string }> }>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { provider } = await params(ctx, providerParams);
  const query = parseQuery(req, integrationLogsQuerySchema);
  return json(
    { items: await listIntegrationLogs(admin, provider, query) },
    { correlationId: ctx.correlationId },
  );
});
