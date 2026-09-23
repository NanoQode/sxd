import { createHmac } from 'node:crypto';
import { ApiError } from '@simplexd/contracts';
import { getDb, schema, systemContext, withActor } from '@simplexd/db';
import { json, parseJson, route } from '@/lib/api/respond';
import { analyticsEventBodySchema } from '@/lib/api/registry/public';
import { env } from '@/lib/env';
import { clientIp, enforceRateLimit, hashIp } from '@/lib/rate-limit';
import { containsEmailLike, CONSENT_VERSION, parseConsentCookie } from '@/components/public/analytics';

export const dynamic = 'force-dynamic';

/**
 * Consent-aware analytics sink. Nothing is stored unless the visitor chose
 * analytics consent; the browser session id is stored only as an HMAC so it
 * cannot be reversed, and any payload carrying an email-like string is
 * rejected before it reaches the database.
 */
export const POST = route(async (req, { correlationId }) => {
  const consent = parseConsentCookie(req.headers.get('cookie'));
  if (consent !== 'analytics') {
    throw new ApiError('forbidden', 'analytics consent has not been granted');
  }
  const ipHash = hashIp(clientIp(req));
  await enforceRateLimit(`analytics:${ipHash}`, { windowSeconds: 60, max: 120 });

  const body = await parseJson(req, analyticsEventBodySchema);
  if (containsEmailLike(body.eventName) || containsEmailLike(body.path) || containsEmailLike(body.props ?? {})) {
    throw new ApiError('validation_failed', 'analytics payloads must not contain personal identifiers', {
      details: [{ path: 'props', message: 'email-like value detected' }],
    });
  }
  const sessionHash = createHmac('sha256', env().AUTH_SECRET)
    .update(`analytics:${body.sessionId}`)
    .digest('hex')
    .slice(0, 32);

  await withActor(getDb(), systemContext(correlationId), (tx) =>
    tx.insert(schema.analyticsEvents).values({
      sessionHash,
      eventName: body.eventName,
      path: body.path,
      props: body.props ?? null,
      consentVersion: CONSENT_VERSION,
    }),
  );
  return json({ accepted: true }, { status: 202, correlationId });
});
