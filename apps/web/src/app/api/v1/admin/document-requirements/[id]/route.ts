import { documentRequirementPatchSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { idParams, requireAdminContext } from '@/server/admin/http';
import { patchDocumentRequirement } from '@/server/admin/configuration/document-requirements';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/v1/admin/document-requirements/:id — edit a requirement (version token, reason). */
export const PATCH = route<Ctx>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, documentRequirementPatchSchema);
  return json(await patchDocumentRequirement(admin, id, body), {
    correlationId: ctx.correlationId,
  });
});
