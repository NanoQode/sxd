import { reportTemplateCreateSchema, reportTemplateListQuerySchema } from '@simplexd/contracts';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import '@/lib/api/registry/admin-configuration';
import { requireAdminContext } from '@/server/admin/http';
import {
  createReportTemplate,
  listReportTemplates,
} from '@/server/admin/configuration/report-templates';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/report-templates — templates by kind (any report permission). */
export const GET = route(async (req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  const query = parseQuery(req, reportTemplateListQuerySchema);
  return json({ items: await listReportTemplates(ctx, query) }, { correlationId });
});

/** POST /api/v1/admin/report-templates — create a template; activating it deactivates the kind's other template (reports.review). */
export const POST = route(async (req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  const body = await parseJson(req, reportTemplateCreateSchema);
  return json(await createReportTemplate(ctx, body), { status: 201, correlationId });
});
