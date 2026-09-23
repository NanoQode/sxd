import 'server-only';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb, schema, systemContext, withActor, type DbExecutor } from '@simplexd/db';
import { defaultIntegrationEnvironment, loadIntegrationConfig } from '@simplexd/integrations/config';
import {
  CalendarAuthError,
  CalendarProviderError,
  DevCalendarProvider,
  createCalendarProvider,
  googleRedirectUri,
  isDevelopmentEnvironment,
  type BusyInterval,
  type CalendarCredentials,
  type CalendarProvider,
  type TokenSet,
} from '@simplexd/integrations/google';
import { decryptSecret, encryptSecret, keyringFromEnv, type Keyring } from '@simplexd/integrations/secrets';
import { env } from '@/lib/env';
import type { ProviderBusyLoader } from '@/server/appointments/availability';

/**
 * Web-side calendar runtime: which adapter is active (Google when a client
 * id/secret is configured and enabled in Admin → Integrations, the labelled
 * development adapter otherwise and only outside production), how organiser
 * credentials are decrypted from `secret_references`, and how rotated tokens
 * are re-encrypted. The worker carries the same rules in
 * apps/worker/src/handlers/calendar.ts; keep both in step.
 */

export const CALENDAR_OAUTH_CALLBACK_PATH = '/api/v1/calendar/callback';
export const CALENDAR_PUSH_PATH = '/api/v1/calendar/push';

export type ConnectionRow = typeof schema.calendarConnections.$inferSelect;

export interface CalendarProviderInfo {
  adapter: 'google' | 'dev';
  provider: CalendarProvider;
  clientConfigured: boolean;
  redirectUri: string;
  environment: 'test' | 'live';
}

const devKey = '__sxDevCalendarProvider';

/** Shared with the worker engine when both run in one process (tests). */
export function sharedDevProvider(appEnv: string): DevCalendarProvider {
  const g = globalThis as unknown as Record<string, DevCalendarProvider | undefined>;
  if (!g[devKey]) g[devKey] = new DevCalendarProvider({ appEnv, simulateConference: 'ready' });
  return g[devKey]!;
}

export function calendarKeyring(): Keyring {
  return keyringFromEnv();
}

export function calendarEnvironment(): 'test' | 'live' {
  return defaultIntegrationEnvironment(env().APP_ENV);
}

export function redirectUri(): string {
  return googleRedirectUri(env().APP_URL, CALENDAR_OAUTH_CALLBACK_PATH);
}

export function pushAddress(): string | null {
  const url = env().APP_URL;
  if (!url.startsWith('https://') && env().APP_ENV !== 'test') return null;
  return `${url.replace(/\/+$/, '')}${CALENDAR_PUSH_PATH}`;
}

function readClientId(settings: Record<string, unknown>): string | null {
  const value = settings['clientId'] ?? settings['client_id'] ?? settings['oauthClientId'];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readClientSecret(secrets: Record<string, string>): string | null {
  return secrets['clientSecret'] ?? secrets['client_secret'] ?? secrets['oauthClientSecret'] ?? null;
}

/** Reads the active Google Workspace configuration and returns the provider. */
export async function getCalendarProviderInfo(): Promise<CalendarProviderInfo> {
  const e = env();
  const environment = calendarEnvironment();
  const config = await loadIntegrationConfig(getDb(), 'google_workspace', {
    appEnv: e.APP_ENV,
    environment,
    keyring: calendarKeyring(),
  });
  const clientId = (config?.enabled ? readClientId(config.settings) : null) ?? e.GOOGLE_CLIENT_ID ?? null;
  const clientSecret =
    (config?.enabled ? readClientSecret(config.secrets) : null) ?? e.GOOGLE_CLIENT_SECRET ?? null;
  const clientConfigured = Boolean(clientId && clientSecret);
  const uri = redirectUri();
  if (clientConfigured && (config?.adapter ?? 'google') !== 'dev') {
    return {
      adapter: 'google',
      provider: createCalendarProvider({
        appEnv: e.APP_ENV,
        adapter: 'google',
        clientId,
        clientSecret,
        redirectUri: uri,
      }),
      clientConfigured,
      redirectUri: uri,
      environment,
    };
  }
  if (!isDevelopmentEnvironment(e.APP_ENV)) {
    throw new CalendarProviderError(
      'Google Workspace is not configured; add the OAuth client ID and secret in Admin → Integrations → Google Workspace',
      { code: 'not_configured' },
    );
  }
  return {
    adapter: 'dev',
    provider: sharedDevProvider(e.APP_ENV),
    clientConfigured,
    redirectUri: uri,
    environment,
  };
}

export async function storeTokenSecret(
  tx: DbExecutor,
  input: { fieldName: string; plaintext: string; createdBy?: string | null; environment?: string },
): Promise<string> {
  const enc = encryptSecret(input.plaintext, calendarKeyring());
  const [row] = await tx
    .insert(schema.secretReferences)
    .values({
      provider: 'google_workspace',
      environment: input.environment ?? calendarEnvironment(),
      fieldName: input.fieldName,
      masterKeyId: enc.masterKeyId,
      wrappedDek: enc.wrappedDek,
      dekIv: enc.dekIv,
      dekTag: enc.dekTag,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      tag: enc.tag,
      fingerprint: enc.fingerprint,
      createdBy: input.createdBy ?? null,
    })
    .returning({ id: schema.secretReferences.id });
  return row!.id;
}

export async function retireSecret(tx: DbExecutor, secretId: string | null, now: Date): Promise<void> {
  if (!secretId) return;
  await tx
    .update(schema.secretReferences)
    .set({ retiredAt: now })
    .where(eq(schema.secretReferences.id, secretId));
}

async function loadSecretPlaintext(secretId: string | null): Promise<string | null> {
  if (!secretId) return null;
  const [record] = await withActor(getDb(), systemContext('calendar-secret'), (tx) =>
    tx.select().from(schema.secretReferences).where(eq(schema.secretReferences.id, secretId)),
  );
  if (!record || record.retiredAt) return null;
  return decryptSecret(record, calendarKeyring());
}

async function persistRotatedTokens(connection: ConnectionRow, next: TokenSet): Promise<void> {
  const now = new Date();
  await withActor(getDb(), systemContext('calendar-token-rotation'), async (tx) => {
    const [current] = await tx
      .select()
      .from(schema.calendarConnections)
      .where(eq(schema.calendarConnections.id, connection.id))
      .for('update');
    if (!current) return;
    const patch: Partial<typeof schema.calendarConnections.$inferInsert> = {
      accessTokenExpiresAt: next.expiresAt,
    };
    if (next.accessToken) {
      patch.accessTokenSecretId = await storeTokenSecret(tx, {
        fieldName: 'access_token',
        plaintext: next.accessToken,
        environment: current.environment,
      });
      await retireSecret(tx, current.accessTokenSecretId, now);
    }
    if (next.refreshToken) {
      patch.refreshTokenSecretId = await storeTokenSecret(tx, {
        fieldName: 'refresh_token',
        plaintext: next.refreshToken,
        environment: current.environment,
      });
      await retireSecret(tx, current.refreshTokenSecretId, now);
    }
    await tx
      .update(schema.calendarConnections)
      .set(patch)
      .where(eq(schema.calendarConnections.id, current.id));
  });
}

export async function credentialsForConnection(connection: ConnectionRow): Promise<CalendarCredentials> {
  const [refreshToken, accessToken] = await Promise.all([
    loadSecretPlaintext(connection.refreshTokenSecretId),
    loadSecretPlaintext(connection.accessTokenSecretId),
  ]);
  if (!refreshToken && !accessToken) {
    throw new CalendarAuthError('the stored organiser tokens are missing or retired', {
      providerReason: 'missing_tokens',
    });
  }
  return {
    accessToken: accessToken ?? '',
    refreshToken,
    expiresAt: connection.accessTokenExpiresAt,
    scope: connection.scopes,
    idTokenEmail: connection.accountEmail,
    onRotated: (next) => persistRotatedTokens(connection, next),
  };
}

export function devCredentials(): CalendarCredentials {
  return {
    accessToken: 'dev-access-web',
    refreshToken: null,
    expiresAt: null,
    scope: [],
    idTokenEmail: 'organiser@dev.simplexd.local',
  };
}

export async function listUsableConnections(): Promise<ConnectionRow[]> {
  return withActor(getDb(), systemContext('calendar-connections'), (tx) =>
    tx
      .select()
      .from(schema.calendarConnections)
      .where(
        and(
          eq(schema.calendarConnections.provider, 'google'),
          eq(schema.calendarConnections.environment, calendarEnvironment()),
          inArray(schema.calendarConnections.status, ['connected', 'degraded']),
        ),
      )
      .orderBy(desc(schema.calendarConnections.connectedAt)),
  );
}

export interface Organizer {
  adapter: 'google' | 'dev';
  provider: CalendarProvider;
  connection: ConnectionRow | null;
  credentials: CalendarCredentials;
  calendarId: string;
}

/** Organiser grant for a staff member (own connection → business organiser → dev adapter). */
export async function resolveOrganizer(staffUserId: string | null): Promise<Organizer | null> {
  const info = await getCalendarProviderInfo();
  const connections = await listUsableConnections();
  const chosen = connections.find((c) => c.organizerUserId === staffUserId) ?? connections[0] ?? null;
  if (chosen) {
    return {
      adapter: info.adapter,
      provider: info.provider,
      connection: chosen,
      credentials: await credentialsForConnection(chosen),
      calendarId: chosen.calendarId ?? 'primary',
    };
  }
  if (info.adapter === 'dev') {
    return {
      adapter: 'dev',
      provider: info.provider,
      connection: null,
      credentials: devCredentials(),
      calendarId: 'primary',
    };
  }
  return null;
}

/**
 * Free/busy from the organiser's Google calendar for staff who connected one.
 * Only busy intervals are read (never titles). Errors propagate so the caller
 * can report `providerBusyIncluded: false` instead of pretending.
 */
export function providerBusyLoader(): ProviderBusyLoader {
  return async (staffUserIds, from, to) => {
    const out = new Map<string, BusyInterval[]>();
    const connections = await listUsableConnections();
    if (connections.length === 0) return out;
    const info = await getCalendarProviderInfo();
    for (const staffUserId of staffUserIds) {
      const connection = connections.find((c) => c.organizerUserId === staffUserId);
      if (!connection) continue;
      const credentials = await credentialsForConnection(connection);
      const result = await info.provider.freeBusy(credentials, {
        calendarIds: [connection.calendarId ?? 'primary'],
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
      });
      out.set(
        staffUserId,
        result.busy.map((b) => ({ start: b.start, end: b.end })),
      );
    }
    return out;
  };
}
