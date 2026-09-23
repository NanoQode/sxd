import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { ApiError, type CalendarConnectionDto } from '@simplexd/contracts';
import { getDb, schema, systemContext, withActor } from '@simplexd/db';
import {
  CalendarAuthError,
  DEFAULT_GOOGLE_SCOPES,
  beginAuthorization,
  missingScopes,
  verifyState,
} from '@simplexd/integrations/google';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { env } from '@/lib/env';
import { enqueueCalendarSync } from '@/server/appointments/jobs';
import { toConnectionDto } from './admin';
import {
  credentialsForConnection,
  getCalendarProviderInfo,
  retireSecret,
  storeTokenSecret,
  type ConnectionRow,
} from './runtime';

/**
 * Organiser connection: server-side authorisation code flow with PKCE and an
 * HMAC-signed `state`. The nonce, the PKCE verifier and the connecting user are
 * kept in a short-lived HttpOnly cookie (itself HMAC-signed) so the callback
 * can prove it belongs to the session that started the flow. Refresh and
 * access tokens are envelope-encrypted in `secret_references`; the plaintext
 * never leaves the request that received it.
 */

export const OAUTH_COOKIE = 'sx_gcal_oauth';
export const OAUTH_COOKIE_MAX_AGE_SECONDS = 600;

interface PendingCookie {
  state: string;
  codeVerifier: string;
  userId: string;
  calendarId: string | null;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function encodePendingCookie(pending: PendingCookie, secret = env().AUTH_SECRET): string {
  const payload = Buffer.from(JSON.stringify(pending), 'utf8').toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export function decodePendingCookie(value: string | null | undefined, secret = env().AUTH_SECRET): PendingCookie | null {
  if (!value) return null;
  const [payload, signature] = value.split('.');
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as PendingCookie;
    if (!parsed.state || !parsed.codeVerifier || !parsed.userId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface ConnectStart {
  authorizationUrl: string;
  adapter: 'google' | 'dev';
  cookieValue: string;
}

export async function startConnect(
  identity: RequestIdentity,
  options: { calendarId?: string | null } = {},
): Promise<ConnectStart> {
  const userId = identity.session?.user.id;
  if (!userId) throw new ApiError('unauthenticated', 'sign in required');
  const info = await getCalendarProviderInfo();
  const pending = beginAuthorization(env().AUTH_SECRET);
  const authorizationUrl = info.provider.buildAuthorizationUrl({
    redirectUri: info.redirectUri,
    state: pending.signedState,
    codeChallenge: pending.codeChallenge,
    scopes: DEFAULT_GOOGLE_SCOPES,
    loginHint: identity.session?.user.email,
  });
  return {
    authorizationUrl,
    adapter: info.adapter,
    cookieValue: encodePendingCookie({
      state: pending.state,
      codeVerifier: pending.codeVerifier,
      userId,
      calendarId: options.calendarId ?? null,
    }),
  };
}

export interface CallbackInput {
  code: string | null;
  state: string | null;
  error: string | null;
  cookieValue: string | null;
  correlationId: string;
  now?: Date;
}

export interface CallbackResult {
  connection: CalendarConnectionDto;
  missingScopes: string[];
}

export async function completeConnect(
  identity: RequestIdentity,
  input: CallbackInput,
): Promise<CallbackResult> {
  const now = input.now ?? new Date();
  const userId = identity.session?.user.id;
  if (!userId) throw new ApiError('unauthenticated', 'sign in required');
  if (input.error) {
    throw new ApiError('provider_unavailable', `Google refused the authorisation: ${input.error}`, {
      retryable: false,
    });
  }
  if (!input.code || !input.state) throw new ApiError('validation_failed', 'code and state are required');
  const verified = verifyState(input.state, env().AUTH_SECRET, { now });
  if (!verified.ok) {
    throw new ApiError('validation_failed', `OAuth state rejected (${verified.reason}); start the connection again`);
  }
  const pending = decodePendingCookie(input.cookieValue);
  if (!pending || pending.state !== verified.state || pending.userId !== userId) {
    throw new ApiError('validation_failed', 'this callback does not match the session that started the connection');
  }
  const info = await getCalendarProviderInfo();
  let tokens;
  try {
    tokens = await info.provider.exchangeCode({
      code: input.code,
      redirectUri: info.redirectUri,
      codeVerifier: pending.codeVerifier,
    });
  } catch (err) {
    if (err instanceof CalendarAuthError) {
      throw new ApiError('provider_unavailable', `${err.message}. ${err.instructions}`, { retryable: false });
    }
    throw err;
  }
  const missing = missingScopes(tokens.scope, DEFAULT_GOOGLE_SCOPES);
  const environment = info.environment;

  // Pick the booking calendar: the requested one, else the primary calendar.
  let calendarId: string | null = pending.calendarId;
  let calendarError: string | null = null;
  try {
    const calendars = await info.provider.listCalendars({ ...tokens });
    const chosen =
      calendars.find((c) => c.id === calendarId) ??
      calendars.find((c) => c.primary) ??
      calendars.find((c) => c.accessRole === 'owner' || c.accessRole === 'writer');
    calendarId = chosen?.id ?? calendarId ?? 'primary';
  } catch (err) {
    calendarError = err instanceof Error ? err.message : 'could not list calendars';
    calendarId ??= 'primary';
  }

  const connectionId = await withActor(getDb(), systemContext(input.correlationId), async (tx) => {
    const [existing] = await tx
      .select()
      .from(schema.calendarConnections)
      .where(
        and(
          eq(schema.calendarConnections.provider, 'google'),
          eq(schema.calendarConnections.environment, environment),
          eq(schema.calendarConnections.organizerUserId, userId),
        ),
      )
      .for('update');
    const refreshTokenSecretId = tokens.refreshToken
      ? await storeTokenSecret(tx, {
          fieldName: 'refresh_token',
          plaintext: tokens.refreshToken,
          createdBy: userId,
          environment,
        })
      : (existing?.refreshTokenSecretId ?? null);
    const accessTokenSecretId = tokens.accessToken
      ? await storeTokenSecret(tx, {
          fieldName: 'access_token',
          plaintext: tokens.accessToken,
          createdBy: userId,
          environment,
        })
      : (existing?.accessTokenSecretId ?? null);
    if (existing) {
      if (tokens.refreshToken) await retireSecret(tx, existing.refreshTokenSecretId, now);
      if (tokens.accessToken) await retireSecret(tx, existing.accessTokenSecretId, now);
    }
    const status = missing.length > 0 ? ('degraded' as const) : ('connected' as const);
    const values = {
      accountEmail: tokens.idTokenEmail,
      calendarId,
      scopes: tokens.scope,
      status,
      refreshTokenSecretId,
      accessTokenSecretId,
      accessTokenExpiresAt: tokens.expiresAt,
      lastCheckedAt: now,
      lastCheckOk: missing.length === 0 && !calendarError,
      lastErrorSanitized:
        missing.length > 0
          ? `Google granted fewer scopes than required; missing: ${missing.join(', ')}. Reconnect and accept every permission.`
          : calendarError,
      connectedAt: now,
      disconnectedAt: null,
    };
    let id: string;
    if (existing) {
      await tx
        .update(schema.calendarConnections)
        .set(values)
        .where(eq(schema.calendarConnections.id, existing.id));
      id = existing.id;
    } else {
      const [row] = await tx
        .insert(schema.calendarConnections)
        .values({ provider: 'google', environment, organizerUserId: userId, ...values })
        .returning({ id: schema.calendarConnections.id });
      id = row!.id;
    }
    await recordAudit(tx, identity, {
      action: existing ? 'calendar.reconnected' : 'calendar.connected',
      entityType: 'calendar_connection',
      entityId: id,
      after: { status, accountEmail: tokens.idTokenEmail, scopes: tokens.scope, calendarId, adapter: info.adapter },
      correlationId: input.correlationId,
    });
    if (status === 'connected') {
      // Appointments whose sync failed for lack of a valid grant can now be retried.
      const failed = await tx
        .select({
          id: schema.appointments.id,
          organizationId: schema.appointments.organizationId,
          syncVersion: schema.eventSyncs.syncVersion,
        })
        .from(schema.appointments)
        .innerJoin(schema.eventSyncs, eq(schema.eventSyncs.appointmentId, schema.appointments.id))
        .where(
          and(
            eq(schema.appointments.calendarSyncStatus, 'failed'),
            inArray(schema.appointments.status, ['pending_confirmation', 'confirmed', 'rescheduled']),
          ),
        );
      for (const a of failed) {
        await tx
          .update(schema.appointments)
          .set({ calendarSyncStatus: 'pending' })
          .where(eq(schema.appointments.id, a.id));
        await enqueueCalendarSync(tx, {
          appointmentId: a.id,
          syncVersion: a.syncVersion,
          organizationId: a.organizationId,
          actorUserId: userId,
          correlationId: input.correlationId,
          nonce: `reconnect-${now.getTime()}`,
        });
      }
    }
    return id;
  });
  const [connection] = await withActor(getDb(), systemContext(input.correlationId), (tx) =>
    tx.select().from(schema.calendarConnections).where(eq(schema.calendarConnections.id, connectionId)),
  );
  return { connection: await toConnectionDto(connection!), missingScopes: missing };
}

export async function disconnectConnection(
  identity: RequestIdentity,
  connectionId: string,
  options: { correlationId: string; now?: Date },
): Promise<CalendarConnectionDto> {
  const now = options.now ?? new Date();
  const [connection] = await withActor(getDb(), systemContext(options.correlationId), (tx) =>
    tx.select().from(schema.calendarConnections).where(eq(schema.calendarConnections.id, connectionId)),
  );
  if (!connection) throw new ApiError('not_found', 'calendar connection not found');
  let revokeError: string | null = null;
  try {
    const info = await getCalendarProviderInfo();
    const credentials = await credentialsForConnection(connection);
    const token = credentials.refreshToken ?? credentials.accessToken;
    if (token) await info.provider.revoke(token);
    const channels = await withActor(getDb(), systemContext(options.correlationId), (tx) =>
      tx
        .select()
        .from(schema.calendarWatchChannels)
        .where(
          and(
            eq(schema.calendarWatchChannels.calendarConnectionId, connection.id),
            eq(schema.calendarWatchChannels.status, 'active'),
          ),
        ),
    );
    for (const channel of channels) {
      if (!channel.resourceId) continue;
      try {
        await info.provider.stopChannel(credentials, {
          channelId: channel.channelId,
          resourceId: channel.resourceId,
        });
      } catch {
        // Channel expires on its own.
      }
    }
  } catch (err) {
    revokeError = err instanceof Error ? err.message : 'revocation failed';
  }
  await withActor(getDb(), systemContext(options.correlationId), async (tx) => {
    await retireSecret(tx, connection.refreshTokenSecretId, now);
    await retireSecret(tx, connection.accessTokenSecretId, now);
    await tx
      .update(schema.calendarConnections)
      .set({
        status: 'disconnected',
        refreshTokenSecretId: null,
        accessTokenSecretId: null,
        accessTokenExpiresAt: null,
        disconnectedAt: now,
        lastErrorSanitized: revokeError ? `Disconnected locally; Google revocation failed: ${revokeError}` : null,
      })
      .where(eq(schema.calendarConnections.id, connection.id));
    await tx
      .update(schema.calendarWatchChannels)
      .set({ status: 'stopped' })
      .where(eq(schema.calendarWatchChannels.calendarConnectionId, connection.id));
    await recordAudit(tx, identity, {
      action: 'calendar.disconnected',
      entityType: 'calendar_connection',
      entityId: connection.id,
      before: { status: connection.status },
      after: { status: 'disconnected', revokeError },
      correlationId: options.correlationId,
    });
  });
  const [after] = await withActor(getDb(), systemContext(options.correlationId), (tx) =>
    tx.select().from(schema.calendarConnections).where(eq(schema.calendarConnections.id, connection.id)),
  );
  return toConnectionDto(after as ConnectionRow);
}
