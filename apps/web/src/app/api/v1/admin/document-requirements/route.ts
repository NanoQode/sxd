import {
  documentRequirementCreateSchema,
  documentRequirementListQuerySchema,
} from '@simplexd/contracts';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import '@/lib/api/registry/admin-configuration';
import { requireAdminContext } from '@/server/admin/http';
import {
  createDocumentRequirement,
  listDocumentRequirements,
} from '@/server/admin/configuration/document-requirements';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/document-requirements — per service or for all services. */
export const GET = route(async (req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  const query = parseQuery(req, documentRequirementListQuerySchema);
  return json({ items: await listDocumentRequirements(ctx, query) }, { correlationId });
});

/** POST /api/v1/admin/document-requirements — add a requirement (pricing.manage). */
export const POST = route(async (req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  const body = await parseJson(req, documentRequirementCreateSchema);
  return json(await createDocumentRequirement(ctx, body), { status: 201, correlationId });
});
