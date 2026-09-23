import { reportTemplatePatchSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { idParams, requireAdminContext } from '@/server/admin/http';
import {
  getReportTemplate,
  patchReportTemplate,
} from '@/server/admin/configuration/report-templates';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/v1/admin/report-templates/:id */
export const GET = route<Ctx>(async (_req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  return json(await getReportTemplate(admin, id), { correlationId: ctx.correlationId });
});

/** PATCH /api/v1/admin/report-templates/:id — edit sections, wording or activity (version token, reason). */
export const PATCH = route<Ctx>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, reportTemplatePatchSchema);
  return json(await patchReportTemplate(admin, id, body), { correlationId: ctx.correlationId });
});
