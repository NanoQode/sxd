import { quoteTemplatePatchSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { idParams, requireAdminContext } from '@/server/admin/http';
import {
  getQuoteTemplate,
  patchQuoteTemplate,
} from '@/server/admin/configuration/quote-templates';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/v1/admin/quote-templates/:id */
export const GET = route<Ctx>(async (_req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  return json(await getQuoteTemplate(admin, id), { correlationId: ctx.correlationId });
});

/** PATCH /api/v1/admin/quote-templates/:id — edit lines, scope, exclusions or activity (reason, updatedAt token). */
export const PATCH = route<Ctx>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, quoteTemplatePatchSchema);
  return json(await patchQuoteTemplate(admin, id, body), { correlationId: ctx.correlationId });
});
