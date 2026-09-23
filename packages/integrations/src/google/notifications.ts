import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Google Calendar push notifications (events.watch channels).
 *
 * A notification is an HTTPS POST with headers only — there is NO payload
 * describing the change (search-snippet evidence; the discovery document only
 * defines the Channel resource). Nothing in the request is trusted: after the
 * channel token is verified against the stored hash, the application performs
 * an authenticated incremental `listChanges` with its stored syncToken and
 * reconciles from what Google returns.
 *
 * Header names below (X-Goog-Channel-ID, X-Goog-Channel-Token,
 * X-Goog-Resource-ID, X-Goog-Resource-State, X-Goog-Message-Number,
 * X-Goog-Resource-URI, X-Goog-Channel-Expiration) are NOT VERIFIED against the
 * live push guide (blocked); they come from official-page search snippets.
 */

export type ResourceState = 'sync' | 'exists' | 'not_exists';

export interface PushNotification {
  channelId: string;
  resourceId: string;
  resourceState: ResourceState;
  /** Sync messages always carry 1. */
  messageNumber: number | null;
  /** Raw token echoed by Google; treat as a secret and never log it. */
  channelToken: string | null;
  resourceUri: string | null;
  channelExpiration: string | null;
}

export type HeaderSource =
  | { get(name: string): string | null | undefined }
  | Record<string, string | string[] | undefined>;

function readHeader(headers: HeaderSource, name: string): string | null {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get(name: string): string | null | undefined }).get(name);
    return value ? String(value) : null;
  }
  const record = headers as Record<string, string | string[] | undefined>;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  }
  return null;
}

export type ParsePushResult =
  | { ok: true; notification: PushNotification }
  | { ok: false; reason: string };

/** Parses the notification headers. Does not validate the token (see verifyChannelToken). */
export function parsePushNotification(headers: HeaderSource): ParsePushResult {
  const channelId = readHeader(headers, 'x-goog-channel-id');
  const resourceId = readHeader(headers, 'x-goog-resource-id');
  const stateRaw = readHeader(headers, 'x-goog-resource-state');
  if (!channelId) return { ok: false, reason: 'missing X-Goog-Channel-ID' };
  if (!resourceId) return { ok: false, reason: 'missing X-Goog-Resource-ID' };
  if (stateRaw !== 'sync' && stateRaw !== 'exists' && stateRaw !== 'not_exists')
    return { ok: false, reason: `unexpected X-Goog-Resource-State: ${stateRaw ?? 'missing'}` };
  const numberRaw = readHeader(headers, 'x-goog-message-number');
  const messageNumber = numberRaw && /^\d+$/.test(numberRaw) ? Number(numberRaw) : null;
  return {
    ok: true,
    notification: {
      channelId,
      resourceId,
      resourceState: stateRaw,
      messageNumber,
      channelToken: readHeader(headers, 'x-goog-channel-token'),
      resourceUri: readHeader(headers, 'x-goog-resource-uri'),
      channelExpiration: readHeader(headers, 'x-goog-channel-expiration'),
    },
  };
}

/** Random channel token sent to Google in events.watch; only its hash is stored. */
export function createChannelToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashChannelToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison of the echoed token's hash against the stored hash. */
export function verifyChannelToken(
  notification: Pick<PushNotification, 'channelToken'>,
  storedTokenHash: string | null | undefined,
): boolean {
  if (!notification.channelToken || !storedTokenHash) return false;
  const actual = Buffer.from(hashChannelToken(notification.channelToken), 'hex');
  const expected = Buffer.from(storedTokenHash.trim().toLowerCase(), 'hex');
  if (actual.length !== expected.length || actual.length === 0) return false;
  return timingSafeEqual(actual, expected);
}

export type PushAction = 'acknowledge' | 'fetch_changes';

/** `sync` only confirms the channel; `exists`/`not_exists` mean "something changed, go and fetch". */
export function pushNotificationAction(notification: Pick<PushNotification, 'resourceState'>): PushAction {
  return notification.resourceState === 'sync' ? 'acknowledge' : 'fetch_changes';
}

export type ValidatedPush =
  | {
      ok: true;
      notification: PushNotification;
      action: PushAction;
      /** Always 2xx once validated; Google retries only on 5xx. */
      respondWithStatus: 200;
    }
  | {
      ok: false;
      reason: string;
      /** 4xx: Google records a message failure and does not retry. */
      respondWithStatus: 400 | 403 | 404;
      channelId: string | null;
    };

/**
 * Full validation: parse headers, look up the stored token hash by channel id
 * (database), compare in constant time and tell the caller what to do next.
 * The caller must then run listChanges with the stored syncToken; it must not
 * derive any event detail from the notification itself.
 */
export async function validatePushNotification(
  headers: HeaderSource,
  lookupTokenHash: (channelId: string) => Promise<string | null> | string | null,
): Promise<ValidatedPush> {
  const parsed = parsePushNotification(headers);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, respondWithStatus: 400, channelId: null };
  const { notification } = parsed;
  const storedHash = await lookupTokenHash(notification.channelId);
  if (!storedHash)
    return {
      ok: false,
      reason: 'unknown or stopped channel',
      respondWithStatus: 404,
      channelId: notification.channelId,
    };
  if (!verifyChannelToken(notification, storedHash))
    return {
      ok: false,
      reason: 'channel token mismatch',
      respondWithStatus: 403,
      channelId: notification.channelId,
    };
  return {
    ok: true,
    notification,
    action: pushNotificationAction(notification),
    respondWithStatus: 200,
  };
}

/** Channels have no auto-renewal: re-watch anything expiring within this window, then stop the old channel. */
export const CHANNEL_RENEWAL_WINDOW_SECONDS = 24 * 60 * 60;

export function channelNeedsRenewal(
  expiration: Date | null,
  now: Date = new Date(),
  windowSeconds: number = CHANNEL_RENEWAL_WINDOW_SECONDS,
): boolean {
  if (!expiration) return true;
  return expiration.getTime() - now.getTime() <= windowSeconds * 1000;
}
