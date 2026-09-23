import { z } from 'zod';
import { uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseQuery, route } from '@/lib/api/respond';
import { getReportTemplateOutline } from '@/server/engagements/reports';
import '@/lib/api/registry/diligence';

export const dynamic = 'force-dynamic';

/** GET /api/v1/report-templates/outline?kind=… — section outline and guidance for authors. */
export const GET = route(async (req, ctx) => {
  const identity = await getIdentity();
  const query = parseQuery(
    req,
    z.object({
      kind: z.enum(['diligence_memo', 'virtual_inspection']),
      templateId: uuidSchema.optional(),
    }),
  );
  return json(await getReportTemplateOutline(identity, query.kind, query.templateId), {
    correlationId: ctx.correlationId,
  });
});
