import { integrationSaveSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { providerParams } from '@/server/integrations/http';
import { getIntegration, saveIntegration } from '@/server/integrations/service';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ provider: string }> };

/** GET /api/v1/admin/integrations/:provider — descriptor plus version history per environment. */
export const GET = route<Ctx>(async (_req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { provider } = await params(ctx, providerParams);
  return json(await getIntegration(admin, provider), { correlationId: ctx.correlationId });
});

/** PUT /api/v1/admin/integrations/:provider — saves a NEW version (configured_unverified); never activates. */
export const PUT = route<Ctx>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { provider } = await params(ctx, providerParams);
  const body = await parseJson(req, integrationSaveSchema);
  return json(await saveIntegration(admin, provider, body), {
    status: 201,
    correlationId: ctx.correlationId,
  });
});
