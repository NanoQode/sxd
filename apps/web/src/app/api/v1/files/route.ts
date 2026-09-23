import { ApiError, fileListQuerySchema } from '@simplexd/contracts';
import { json, parseQuery, route } from '@/lib/api/respond';
import { getIdentity } from '@/lib/auth/session';
import { listFilesForEntity } from '@/server/files/queries';
import '@/lib/api/registry/files';

export const dynamic = 'force-dynamic';

/** GET /api/v1/files?entityType=&entityId= — files attached to an entity the caller may view. */
export const GET = route(async (req, { correlationId }) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const query = parseQuery(req, fileListQuerySchema);
  return json(await listFilesForEntity(identity, query, { correlationId }), { correlationId });
});
