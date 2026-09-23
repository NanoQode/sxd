import { getDb } from '@simplexd/db';
import { processTermiiWebhook } from '@simplexd/notifications';
import { json, route } from '@/lib/api/respond';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/webhooks/termii — delivery receipts and inbound replies.
 * The raw body is verified against the configured signing secret; without a
 * secret the event is recorded as `signature: unchecked` and accepted only
 * outside production. STOP/START keywords update consent and suppressions.
 */
export const POST = route(async (req, { correlationId }) => {
  const rawBody = await req.text();
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const e = env();
  const outcome = await processTermiiWebhook(getDb(), rawBody, headers, {
    appEnv: e.APP_ENV,
    appUrl: e.APP_URL,
    brandName: e.APP_NAME,
  });
  return json(
    {
      accepted: outcome.accepted,
      signature: outcome.signature,
      eventType: outcome.eventType,
      action: outcome.action,
    },
    { status: outcome.status, correlationId },
  );
});
