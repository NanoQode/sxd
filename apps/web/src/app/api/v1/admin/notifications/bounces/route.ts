import { bounceImportSchema } from '@simplexd/contracts';
import { getDb } from '@simplexd/db';
import { processBounce } from '@simplexd/notifications';
import { requireStaff } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';
import { pipelineOptions } from '../_lib';

export const dynamic = 'force-dynamic';

/** POST /api/v1/admin/notifications/bounces — manual bounce/complaint import until a provider feedback webhook exists. */
export const POST = route(async (req, { correlationId }) => {
  const identity = await requireStaff('notifications.templates.manage');
  const body = await parseJson(req, bounceImportSchema);
  const result = await processBounce(
    getDb(),
    {
      email: body.email,
      kind: body.kind,
      reason: body.reason ?? null,
      providerMessageId: body.providerMessageId ?? null,
      source: `manual:${identity.session!.user.id}`,
    },
    pipelineOptions(),
  );
  return json(result, { correlationId });
});
