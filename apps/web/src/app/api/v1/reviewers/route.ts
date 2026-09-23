import { reviewersQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseQuery, route } from '@/lib/api/respond';
import { listReviewers } from '@/server/projects/reviewers';
import '@/lib/api/registry/partner-ops';

export const dynamic = 'force-dynamic';

/** GET /api/v1/reviewers — staff who may be named as a report's professional reviewer. */
export const GET = route(async (req, ctx) => {
  const identity = await getIdentity();
  const query = parseQuery(req, reviewersQuerySchema);
  return json(await listReviewers(identity, query), { correlationId: ctx.correlationId });
});
