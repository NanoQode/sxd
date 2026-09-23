import { z } from 'zod';
import { ApiError, evidenceListQuerySchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseQuery, route } from '@/lib/api/respond';
import { listEvidence } from '@/server/projects/evidence';
import { getSiteVisit } from '@/server/projects/site-visits';

export const dynamic = 'force-dynamic';

export const GET = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const query = parseQuery(req, evidenceListQuerySchema);
  const visit = await getSiteVisit(identity, id);
  if (!visit.projectId) throw new ApiError('not_found', 'site visit not found');
  return json(await listEvidence(identity, visit.projectId, { ...query, siteVisitId: id }), { status: 200, correlationId: ctx.correlationId });
});
