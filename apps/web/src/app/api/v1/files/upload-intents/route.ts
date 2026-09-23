import { ApiError, uploadIntentCreateSchema } from '@simplexd/contracts';
import { json, parseJson, route } from '@/lib/api/respond';
import { getIdentity } from '@/lib/auth/session';
import { enforceRateLimit } from '@/lib/rate-limit';
import { createUploadIntent } from '@/server/files/intents';
import '@/lib/api/registry/files';

export const dynamic = 'force-dynamic';

/** POST /api/v1/files/upload-intents — signed PUT URL or multipart plan for a quarantine upload. */
export const POST = route(async (req, { correlationId }) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  await enforceRateLimit(`files:intents:${identity.session.user.id}`, {
    windowSeconds: 3600,
    max: 120,
  });
  const body = await parseJson(req, uploadIntentCreateSchema);
  const created = await createUploadIntent(identity, body, { correlationId });
  return json(created, { status: 201, correlationId });
});
