import { route } from '@/lib/api/respond';
import { handleCalendarPush } from '@/server/calendar/push';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/calendar/push — Google Calendar push receiver. Validates the
 * channel token against the stored hash and queues an authenticated
 * incremental sync; the notification body is never trusted.
 */
export const POST = route(async (req, { correlationId }) => {
  const outcome = await handleCalendarPush(req.headers, correlationId);
  return new Response(null, { status: outcome.status, headers: { 'cache-control': 'no-store' } });
});
