import { integrationRotateSecretSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { providerParams } from '@/server/integrations/http';
import { rotateIntegrationSecret } from '@/server/integrations/service';

export const dynamic = 'force-dynamic';

/** POST /api/v1/admin/integrations/:provider/rotate-secret — new secret row, old row retired, version bumped (integrations.secrets.rotate, MFA). */
export const POST = route<{ params: Promise<{ provider: string }> }>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { provider } = await params(ctx, providerParams);
  const body = await parseJson(req, integrationRotateSecretSchema);
  return json(await rotateIntegrationSecret(admin, provider, body), {
    correlationId: ctx.correlationId,
  });
});
