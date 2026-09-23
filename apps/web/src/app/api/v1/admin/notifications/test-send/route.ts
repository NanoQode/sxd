import { testSendSchema } from '@simplexd/contracts';
import { getDb } from '@simplexd/db';
import { testSend } from '@simplexd/notifications';
import { requireStaff } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';
import { rateLimit } from '@/lib/rate-limit';
import { ApiError } from '@simplexd/contracts';
import { adminCall, pipelineOptions } from '../_lib';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/admin/notifications/test-send — explicit test email/SMS to a
 * staff-entered address (notifications.test_send, no MFA step). Returns the
 * provider's real answer and the labelled delivery attempt; never a mock.
 */
export const POST = route(async (req, { correlationId }) => {
  const identity = await requireStaff('notifications.test_send');
  const userId = identity.session!.user.id;
  const limit = await rateLimit(`notifications:test-send:${userId}`, {
    windowSeconds: 3600,
    max: 30,
  });
  if (!limit.allowed) {
    throw new ApiError('rate_limited', 'too many test sends; try again later', {
      retryAfterSeconds: limit.retryAfterSeconds,
    });
  }
  const body = await parseJson(req, testSendSchema);
  const result = await adminCall(() =>
    testSend(getDb(), body, { userId, correlationId }, pipelineOptions()),
  );
  return json(result, { correlationId });
});
