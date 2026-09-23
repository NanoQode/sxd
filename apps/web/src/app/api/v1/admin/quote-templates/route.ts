import { quoteTemplateCreateSchema, quoteTemplateListQuerySchema } from '@simplexd/contracts';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import '@/lib/api/registry/admin-configuration';
import { requireAdminContext } from '@/server/admin/http';
import {
  createQuoteTemplate,
  listQuoteTemplates,
} from '@/server/admin/configuration/quote-templates';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/quote-templates — templates per service (pricing.manage or quotes.issue). */
export const GET = route(async (req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  const query = parseQuery(req, quoteTemplateListQuerySchema);
  return json({ items: await listQuoteTemplates(ctx, query) }, { correlationId });
});

/** POST /api/v1/admin/quote-templates — create a template (pricing.manage). */
export const POST = route(async (req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  const body = await parseJson(req, quoteTemplateCreateSchema);
  return json(await createQuoteTemplate(ctx, body), { status: 201, correlationId });
});
