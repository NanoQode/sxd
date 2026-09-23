import { ApiError, communicationsTestSendSchema } from '@simplexd/contracts';
import { requireStaff } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';
import '@/lib/api/registry/communications';
import { rateLimit } from '@/lib/rate-limit';
import { adminContext } from '@/server/admin/context';
import { sendTestMessage } from '@/server/admin/communications/service';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/admin/notifications/test-send — explicit test email/SMS to a
 * staff-entered address (notifications.test_send, no MFA step). Returns the
 * provider's real answer and the labelled, masked delivery attempt; templates
 * render with sample data only. Development adapters are reported as such.
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
  const body = await parseJson(req, communicationsTestSendSchema);
  const result = await sendTestMessage(adminContext(identity, correlationId), body);
  return json(result, { correlationId });
});
