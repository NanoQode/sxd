import { redirectImportRequestSchema } from '@simplexd/contracts';
import { requireStaff } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';
import { importRedirects } from '@/server/content/redirects';
import '@/lib/api/registry/content-public';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/admin/redirects/import — validate (dryRun, default) or apply a
 * `path,target,status` CSV. Needs content.publish, like single creation.
 */
export const POST = route(async (req, { correlationId }) => {
  const identity = await requireStaff('content.publish');
  const body = await parseJson(req, redirectImportRequestSchema);
  return json(await importRedirects(identity, body, { correlationId }), { correlationId });
});
