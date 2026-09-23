import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import {
  appendOutbox,
  schema,
  systemContext,
  withActor,
  type Database,
  type DbExecutor,
} from '@simplexd/db';
import {
  defaultIntegrationEnvironment,
  loadIntegrationConfig,
} from '@simplexd/integrations/config';
import {
  CalendarAuthError,
  CalendarConflictError,
  CalendarProviderError,
  DevCalendarProvider,
  channelNeedsRenewal,
  createCalendarProvider,
  createChannelToken,
  googleRedirectUri,
  hashChannelToken,
  isDevelopmentEnvironment,
  sanitizeErrorMessage,
  type CalendarCredentials,
  type CalendarProvider,
  type ConferenceInfo,
  type EventAttendee,
  type EventResult,
  type TokenSet,
} from '@simplexd/integrations/google';
import {
  decryptSecret,
  encryptSecret,
  keyringFromEnv,
  type Keyring,
} from '@simplexd/integrations/secrets';
import { NonRetryableJobError, type JobRunner } from '../runner';

/**
 * Google Calendar / Meet synchronisation engine and its job handlers.
 *
 * Contract with the web app (apps/web/src/server/appointments):
 * - `calendar.sync_event` {appointmentId, retryConference?} creates or patches
 *   the organiser's event. The conference request id stored in `event_syncs`
 *   is reused on every retry so a retried insert can never produce a second
 *   Meet; a retry after a *failed* conference gets a NEW request id (Google
 *   ignores a repeated one). Patches send `If-Match` with the stored etag and
 *   reconcile on 412 by re-reading the event first.
 * - `calendar.cancel_event` {appointmentId} deletes the event (etag-checked).
 * - `calendar.reconcile_pending_conferences` polls events whose Meet is still
 *   pending; the Join button only appears once Google reports `ready`.
 * - `calendar.renew_watch_channels` re-watches expiring push channels.
 * - `calendar.process_push` {channelId} runs an authenticated incremental
 *   sync (syncToken; 410 ⇒ full resync) and flags organiser-side edits or
 *   deletions as `conflict` for staff review. Nothing is trusted from the
 *   notification itself.
 * - `appointments.scan_reminders` emits `appointment.reminder_due` outbox
 *   events consumed by the notification pipeline.
 *
 * Failures are recorded sanitised on `event_syncs` (attempts, last error) and
 * mirrored on `appointments.calendar_sync_status`; auth failures mark the
 * connection `expired` with reconnect instructions and stop retrying.
 */

export const CALENDAR_JOB_TYPES = {
  syncEvent: 'calendar.sync_event',
  cancelEvent: 'calendar.cancel_event',
  reconcileConferences: 'calendar.reconcile_pending_conferences',
  renewWatchChannels: 'calendar.renew_watch_channels',
  processPush: 'calendar.process_push',
  scanReminders: 'appointments.scan_reminders',
} as const;

/** Path of the push receiver route in apps/web (see app/api/v1/calendar/push). */
export const CALENDAR_PUSH_PATH = '/api/v1/calendar/push';
/** OAuth callback route in apps/web (must be registered in the Google Cloud console). */
export const CALENDAR_OAUTH_CALLBACK_PATH = '/api/v1/calendar/callback';
/** Requested channel lifetime (Google may shorten it; the stored expiration is what counts). */
export const WATCH_CHANNEL_TTL_SECONDS = 7 * 24 * 3600;

type ConnectionRow = typeof schema.calendarConnections.$inferSelect;
type AppointmentRow = typeof schema.appointments.$inferSelect;
type EventSyncRow = typeof schema.eventSyncs.$inferSelect;

export interface CalendarProviderInfo {
  adapter: 'google' | 'dev';
  provider: CalendarProvider;
  clientConfigured: boolean;
  redirectUri: string;
}

export interface CalendarRuntimeOptions {
  db: Database;
  appEnv: string;
  appUrl: string;
  keyring?: Keyring;
  /** Injected in tests; otherwise the shared development instance. */
  devProvider?: DevCalendarProvider;
  now?: () => Date;
}

export interface CalendarRuntime {
  readonly db: Database;
  readonly appEnv: string;
  readonly appUrl: string;
  readonly environment: 'test' | 'live';
  readonly keyring: Keyring;
  now(): Date;
  providerInfo(): Promise<CalendarProviderInfo>;
  credentialsFor(connection: ConnectionRow): Promise<CalendarCredentials>;
  /** Credentials accepted by the development adapter when no organiser is connected. */
  devCredentials(): CalendarCredentials;
}

const devKey = '__sxDevCalendarProvider';

/** One development adapter per process so events created by one job are visible to the next. */
export function sharedDevProvider(appEnv: string): DevCalendarProvider {
  const g = globalThis as unknown as Record<string, DevCalendarProvider | undefined>;
  if (!g[devKey]) {
    g[devKey] = new DevCalendarProvider({ appEnv, simulateConference: 'ready' });
  }
  return g[devKey]!;
}

function readClientId(settings: Record<string, unknown>): string | null {
  const value = settings['clientId'] ?? settings['client_id'] ?? settings['oauthClientId'];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readClientSecret(secrets: Record<string, string>): string | null {
  return (
    secrets['clientSecret'] ?? secrets['client_secret'] ?? secrets['oauthClientSecret'] ?? null
  );
}

async function loadSecretPlaintext(
  db: Database,
  keyring: Keyring,
  secretId: string | null,
): Promise<string | null> {
  if (!secretId) return null;
  const [record] = await withActor(db, systemContext('calendar-secret'), (tx) =>
    tx.select().from(schema.secretReferences).where(eq(schema.secretReferences.id, secretId)),
  );
  if (!record || record.retiredAt) return null;
  return decryptSecret(
    {
      masterKeyId: record.masterKeyId,
      wrappedDek: record.wrappedDek,
      dekIv: record.dekIv,
      dekTag: record.dekTag,
      ciphertext: record.ciphertext,
      iv: record.iv,
      tag: record.tag,
      fingerprint: record.fingerprint,
    },
    keyring,
  );
}

/** Stores a plaintext token as a new envelope-encrypted secret and returns its id. */
export async function storeTokenSecret(
  tx: DbExecutor,
  keyring: Keyring,
  input: { environment: string; fieldName: string; plaintext: string; createdBy?: string | null },
): Promise<string> {
  const enc = encryptSecret(input.plaintext, keyring);
  const [row] = await tx
    .insert(schema.secretReferences)
    .values({
      provider: 'google_workspace',
      environment: input.environment,
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

export async function retireSecret(
  tx: DbExecutor,
  secretId: string | null,
  now: Date,
): Promise<void> {
  if (!secretId) return;
  await tx
    .update(schema.secretReferences)
    .set({ retiredAt: now })
    .where(eq(schema.secretReferences.id, secretId));
}

/**
 * Persists rotated tokens (the Google client refreshes lazily and emits the
 * new set). The newest refresh token always wins; old secrets are retired,
 * never overwritten, so the audit trail keeps rotation metadata.
 */
export async function persistRotatedTokens(
  db: Database,
  keyring: Keyring,
  connection: ConnectionRow,
  next: TokenSet,
  now: Date,
): Promise<void> {
  await withActor(db, systemContext('calendar-token-rotation'), async (tx) => {
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
      patch.accessTokenSecretId = await storeTokenSecret(tx, keyring, {
        environment: current.environment,
        fieldName: 'access_token',
        plaintext: next.accessToken,
      });
      await retireSecret(tx, current.accessTokenSecretId, now);
    }
    if (next.refreshToken) {
      patch.refreshTokenSecretId = await storeTokenSecret(tx, keyring, {
        environment: current.environment,
        fieldName: 'refresh_token',
        plaintext: next.refreshToken,
      });
      await retireSecret(tx, current.refreshTokenSecretId, now);
    }
    await tx
      .update(schema.calendarConnections)
      .set(patch)
      .where(eq(schema.calendarConnections.id, current.id));
  });
}

export function createCalendarRuntime(options: CalendarRuntimeOptions): CalendarRuntime {
  const keyring = options.keyring ?? keyringFromEnv();
  const environment = defaultIntegrationEnvironment(options.appEnv);
  const now = options.now ?? (() => new Date());
  let cached: { info: CalendarProviderInfo; at: number } | null = null;
  const redirectUri = googleRedirectUri(options.appUrl, CALENDAR_OAUTH_CALLBACK_PATH);
  const runtime: CalendarRuntime = {
    db: options.db,
    appEnv: options.appEnv,
    appUrl: options.appUrl,
    environment,
    keyring,
    now,
    async providerInfo() {
      if (cached && now().getTime() - cached.at < 30_000) return cached.info;
      const config = await loadIntegrationConfig(options.db, 'google_workspace', {
        appEnv: options.appEnv,
        environment,
        keyring,
      });
      const clientId =
        (config?.enabled ? readClientId(config.settings) : null) ??
        process.env.GOOGLE_CLIENT_ID ??
        null;
      const clientSecret =
        (config?.enabled ? readClientSecret(config.secrets) : null) ??
        process.env.GOOGLE_CLIENT_SECRET ??
        null;
      const clientConfigured = Boolean(clientId && clientSecret);
      let info: CalendarProviderInfo;
      if (clientConfigured && (config?.adapter ?? 'google') !== 'dev') {
        info = {
          adapter: 'google',
          provider: createCalendarProvider({
            appEnv: options.appEnv,
            adapter: 'google',
            clientId,
            clientSecret,
            redirectUri,
          }),
          clientConfigured,
          redirectUri,
        };
      } else {
        if (!isDevelopmentEnvironment(options.appEnv)) {
          throw new CalendarProviderError(
            'Google Workspace is not configured; the development calendar adapter is refused outside development/test',
            { code: 'not_configured' },
          );
        }
        info = {
          adapter: 'dev',
          provider: options.devProvider ?? sharedDevProvider(options.appEnv),
          clientConfigured,
          redirectUri,
        };
      }
      cached = { info, at: now().getTime() };
      return info;
    },
    async credentialsFor(connection) {
      const [refreshToken, accessToken] = await Promise.all([
        loadSecretPlaintext(options.db, keyring, connection.refreshTokenSecretId),
        loadSecretPlaintext(options.db, keyring, connection.accessTokenSecretId),
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
        onRotated: (next) => persistRotatedTokens(options.db, keyring, connection, next, now()),
      };
    },
    devCredentials() {
      return {
        accessToken: 'dev-access-worker',
        refreshToken: null,
        expiresAt: null,
        scope: [],
        idTokenEmail: 'organiser@dev.simplexd.local',
      };
    },
  };
  return runtime;
}

export interface Organizer {
  adapter: 'google' | 'dev';
  provider: CalendarProvider;
  connection: ConnectionRow | null;
  credentials: CalendarCredentials;
  calendarId: string;
}

/**
 * Picks the organiser grant used for a staff member: their own connection
 * when they connected one, otherwise the business organiser, otherwise the
 * development adapter (never in production).
 */
export async function resolveOrganizer(
  runtime: CalendarRuntime,
  staffUserId: string | null,
): Promise<Organizer> {
  const info = await runtime.providerInfo();
  const connections = await withActor(runtime.db, systemContext('calendar-organizer'), (tx) =>
    tx
      .select()
      .from(schema.calendarConnections)
      .where(
        and(
          eq(schema.calendarConnections.provider, 'google'),
          eq(schema.calendarConnections.environment, runtime.environment),
          inArray(schema.calendarConnections.status, ['connected', 'degraded']),
        ),
      )
      .orderBy(desc(schema.calendarConnections.connectedAt)),
  );
  const chosen =
    connections.find((c) => c.organizerUserId === staffUserId) ?? connections[0] ?? null;
  if (chosen) {
    return {
      adapter: info.adapter,
      provider: info.provider,
      connection: chosen,
      credentials: await runtime.credentialsFor(chosen),
      calendarId: chosen.calendarId ?? 'primary',
    };
  }
  if (info.adapter === 'dev') {
    return {
      adapter: 'dev',
      provider: info.provider,
      connection: null,
      credentials: runtime.devCredentials(),
      calendarId: 'primary',
    };
  }
  throw new NoOrganizerError();
}

export class NoOrganizerError extends Error {
  constructor() {
    super(
      'No connected Google organiser: connect one in Admin → Integrations → Google Workspace, then retry the sync',
    );
    this.name = 'NoOrganizerError';
  }
}

export async function markConnectionExpired(
  db: Database,
  connectionId: string,
  err: CalendarAuthError,
  now: Date,
): Promise<void> {
  await withActor(db, systemContext('calendar-auth'), (tx) =>
    tx
      .update(schema.calendarConnections)
      .set({
        status: 'expired',
        lastCheckedAt: now,
        lastCheckOk: false,
        lastErrorSanitized: `${sanitizeErrorMessage(err.message)} — ${err.instructions}`.slice(
          0,
          1000,
        ),
      })
      .where(eq(schema.calendarConnections.id, connectionId)),
  );
}

interface SyncContext {
  appointment: AppointmentRow;
  sync: EventSyncRow;
  staff: { name: string; email: string } | null;
}

async function loadSyncContext(db: Database, appointmentId: string): Promise<SyncContext | null> {
  return withActor(db, systemContext('calendar-load'), async (tx) => {
    const [appointment] = await tx
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.id, appointmentId));
    if (!appointment) return null;
    let [sync] = await tx
      .select()
      .from(schema.eventSyncs)
      .where(eq(schema.eventSyncs.appointmentId, appointmentId));
    if (!sync) {
      [sync] = await tx
        .insert(schema.eventSyncs)
        .values({ appointmentId, conferenceRequestId: randomUUID(), status: 'pending' })
        .returning();
    }
    const [staff] = await tx
      .select({ name: schema.user.name, email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, appointment.staffUserId));
    return { appointment, sync: sync!, staff: staff ?? null };
  });
}

function isEmail(value: string | null): value is string {
  return Boolean(value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
}

function attendeesFor(ctx: SyncContext, organizer: Organizer): EventAttendee[] {
  const list: EventAttendee[] = [];
  if (isEmail(ctx.appointment.guestEmail)) {
    list.push({
      email: ctx.appointment.guestEmail,
      displayName: ctx.appointment.guestName ?? undefined,
    });
  }
  const organizerIsStaff = organizer.connection?.organizerUserId === ctx.appointment.staffUserId;
  if (!organizerIsStaff && ctx.staff && isEmail(ctx.staff.email)) {
    list.push({ email: ctx.staff.email, displayName: ctx.staff.name });
  }
  return list;
}

function summaryFor(a: AppointmentRow): string {
  const kind = a.kind.replace(/_/g, ' ');
  return `SimplexD ${kind}${a.guestName ? ` — ${a.guestName}` : ''}`;
}

function descriptionFor(a: AppointmentRow): string {
  const lines = [
    a.topic ? `Topic: ${a.topic}` : null,
    a.notes ? `Notes: ${a.notes}` : null,
    `Customer time zone: ${a.customerTimeZone}`,
    `Booked through SimplexD (appointment ${a.id}).`,
  ];
  return lines.filter(Boolean).join('\n');
}

/** Maps the provider's conference info onto our enum; a requested conference without info stays pending. */
export function mapConference(
  info: ConferenceInfo,
  wanted: boolean,
): { status: 'none' | 'pending' | 'ready' | 'failed'; meetUrl: string | null } {
  if (!wanted) return { status: 'none', meetUrl: null };
  if (info.status === 'ready' && info.meetUrl) return { status: 'ready', meetUrl: info.meetUrl };
  if (info.status === 'failed') return { status: 'failed', meetUrl: null };
  return { status: 'pending', meetUrl: null };
}

async function recordSyncFailure(
  db: Database,
  ctx: SyncContext,
  err: unknown,
  now: Date,
): Promise<void> {
  const message = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
  await withActor(db, systemContext('calendar-failure'), async (tx) => {
    await tx
      .update(schema.eventSyncs)
      .set({
        status: 'failed',
        attempts: sql`${schema.eventSyncs.attempts} + 1`,
        lastErrorSanitized: message.slice(0, 500),
      })
      .where(eq(schema.eventSyncs.id, ctx.sync.id));
    await tx
      .update(schema.appointments)
      .set({ calendarSyncStatus: 'failed' })
      .where(eq(schema.appointments.id, ctx.appointment.id));
  });
  void now;
}

async function persistEventResult(
  db: Database,
  ctx: SyncContext,
  organizer: Organizer,
  result: EventResult,
  input: { status: 'created' | 'updated'; conferenceRequestId: string; now: Date },
): Promise<void> {
  const wanted = ctx.appointment.meetingProvider === 'google_meet';
  const conference = mapConference(result.conference, wanted);
  await withActor(db, systemContext('calendar-persist'), async (tx) => {
    await tx
      .update(schema.eventSyncs)
      .set({
        calendarConnectionId: organizer.connection?.id ?? null,
        providerEventId: result.eventId,
        providerCalendarId: organizer.calendarId,
        conferenceRequestId: input.conferenceRequestId,
        etag: result.etag,
        sequence: result.sequence,
        status: input.status,
        conferenceStatus: conference.status,
        meetUrl: conference.meetUrl,
        lastSyncedAt: input.now,
        lastErrorSanitized:
          conference.status === 'failed'
            ? 'Google reported the Meet conference request as failed; retry creates a new request id'
            : null,
      })
      .where(eq(schema.eventSyncs.id, ctx.sync.id));
    await tx
      .update(schema.appointments)
      .set({
        calendarSyncStatus: 'synced',
        conferenceStatus: conference.status,
        meetingUrl: conference.meetUrl,
      })
      .where(eq(schema.appointments.id, ctx.appointment.id));
  });
}

/** Creates or patches the organiser event for an appointment. */
export async function syncAppointmentEvent(
  runtime: CalendarRuntime,
  appointmentId: string,
  options: { retryConference?: boolean } = {},
): Promise<{ outcome: 'created' | 'updated' | 'cancelled' | 'skipped'; conferenceStatus: string }> {
  const ctx = await loadSyncContext(runtime.db, appointmentId);
  if (!ctx) throw new NonRetryableJobError(`appointment ${appointmentId} not found`);
  if (ctx.appointment.status === 'cancelled') {
    await cancelAppointmentEvent(runtime, appointmentId);
    return { outcome: 'cancelled', conferenceStatus: ctx.appointment.conferenceStatus };
  }
  const now = runtime.now();
  let organizer: Organizer;
  try {
    organizer = await resolveOrganizer(runtime, ctx.appointment.staffUserId);
  } catch (err) {
    await recordSyncFailure(runtime.db, ctx, err, now);
    if (err instanceof NoOrganizerError || err instanceof CalendarProviderError) {
      throw new NonRetryableJobError(err.message);
    }
    throw err;
  }
  const wanted = ctx.appointment.meetingProvider === 'google_meet';
  const retry = Boolean(options.retryConference) && wanted && ctx.sync.providerEventId !== null;
  const conferenceRequestId = retry ? randomUUID() : ctx.sync.conferenceRequestId;
  const attendees = attendeesFor(ctx, organizer);
  const base = {
    summary: summaryFor(ctx.appointment),
    description: descriptionFor(ctx.appointment),
    start: ctx.appointment.startsAt.toISOString(),
    end: ctx.appointment.endsAt.toISOString(),
    timeZone: ctx.appointment.businessTimeZone,
    attendees,
  };
  try {
    let result: EventResult;
    let status: 'created' | 'updated';
    if (!ctx.sync.providerEventId) {
      result = await organizer.provider.createEvent(organizer.credentials, {
        calendarId: organizer.calendarId,
        appointmentId: ctx.appointment.id,
        conferenceRequestId,
        ...base,
        location: ctx.appointment.locationNote ?? undefined,
        sendUpdates: 'all',
        conference: wanted,
        privateProps: { simplexdKind: ctx.appointment.kind },
      });
      status = 'created';
    } else {
      const calendarId = ctx.sync.providerCalendarId ?? organizer.calendarId;
      const patch = { ...base, ...(retry ? { conferenceRequestId } : {}) };
      try {
        result = await organizer.provider.updateEvent(organizer.credentials, {
          calendarId,
          eventId: ctx.sync.providerEventId,
          etag: ctx.sync.etag,
          patch,
          sendUpdates: 'all',
        });
      } catch (err) {
        if (!(err instanceof CalendarConflictError)) throw err;
        // 412: the event changed on Google's side. Re-read, then retry with the fresh etag.
        const fresh = await organizer.provider.getEvent(organizer.credentials, {
          calendarId,
          eventId: ctx.sync.providerEventId,
        });
        result = await organizer.provider.updateEvent(organizer.credentials, {
          calendarId,
          eventId: ctx.sync.providerEventId,
          etag: fresh.etag,
          patch,
          sendUpdates: 'all',
        });
      }
      status = 'updated';
    }
    await persistEventResult(runtime.db, ctx, organizer, result, {
      status,
      conferenceRequestId,
      now,
    });
    const conference = mapConference(result.conference, wanted);
    return { outcome: status, conferenceStatus: conference.status };
  } catch (err) {
    await recordSyncFailure(runtime.db, ctx, err, now);
    if (err instanceof CalendarAuthError) {
      if (organizer.connection) {
        await markConnectionExpired(runtime.db, organizer.connection.id, err, now);
      }
      throw new NonRetryableJobError(`${err.message}; ${err.instructions}`);
    }
    if (err instanceof CalendarProviderError && !err.retryable && err.code === 'invalid_request') {
      throw new NonRetryableJobError(err.message);
    }
    throw err;
  }
}

/** Deletes the organiser event after a cancellation (etag-checked, tolerant of an already deleted event). */
export async function cancelAppointmentEvent(
  runtime: CalendarRuntime,
  appointmentId: string,
): Promise<'cancelled' | 'already_gone' | 'no_event'> {
  const ctx = await loadSyncContext(runtime.db, appointmentId);
  if (!ctx) throw new NonRetryableJobError(`appointment ${appointmentId} not found`);
  const now = runtime.now();
  const markCancelled = () =>
    withActor(runtime.db, systemContext('calendar-cancel'), async (tx) => {
      await tx
        .update(schema.eventSyncs)
        .set({ status: 'cancelled', lastSyncedAt: now, lastErrorSanitized: null })
        .where(eq(schema.eventSyncs.id, ctx.sync.id));
      await tx
        .update(schema.appointments)
        .set({ calendarSyncStatus: 'cancelled' })
        .where(eq(schema.appointments.id, appointmentId));
    });
  if (!ctx.sync.providerEventId) {
    await markCancelled();
    return 'no_event';
  }
  let organizer: Organizer;
  try {
    organizer = await resolveOrganizer(runtime, ctx.appointment.staffUserId);
  } catch (err) {
    await recordSyncFailure(runtime.db, ctx, err, now);
    throw err instanceof NoOrganizerError ? new NonRetryableJobError(err.message) : err;
  }
  const calendarId = ctx.sync.providerCalendarId ?? organizer.calendarId;
  try {
    let result;
    try {
      result = await organizer.provider.cancelEvent(organizer.credentials, {
        calendarId,
        eventId: ctx.sync.providerEventId,
        etag: ctx.sync.etag,
        sendUpdates: 'all',
      });
    } catch (err) {
      if (!(err instanceof CalendarConflictError)) throw err;
      const fresh = await organizer.provider.getEvent(organizer.credentials, {
        calendarId,
        eventId: ctx.sync.providerEventId,
      });
      result = await organizer.provider.cancelEvent(organizer.credentials, {
        calendarId,
        eventId: ctx.sync.providerEventId,
        etag: fresh.etag,
        sendUpdates: 'all',
      });
    }
    await markCancelled();
    return result.status;
  } catch (err) {
    if (err instanceof CalendarProviderError && err.code === 'not_found') {
      await markCancelled();
      return 'already_gone';
    }
    await recordSyncFailure(runtime.db, ctx, err, now);
    if (err instanceof CalendarAuthError) {
      if (organizer.connection)
        await markConnectionExpired(runtime.db, organizer.connection.id, err, now);
      throw new NonRetryableJobError(`${err.message}; ${err.instructions}`);
    }
    throw err;
  }
}

/** Polls events whose Meet conference is still pending and records the real outcome. */
export async function reconcilePendingConferences(
  runtime: CalendarRuntime,
  options: { limit?: number } = {},
): Promise<{ checked: number; ready: number; failed: number }> {
  const rows = await withActor(runtime.db, systemContext('calendar-reconcile'), (tx) =>
    tx
      .select({ sync: schema.eventSyncs, appointment: schema.appointments })
      .from(schema.eventSyncs)
      .innerJoin(schema.appointments, eq(schema.appointments.id, schema.eventSyncs.appointmentId))
      .where(
        and(
          eq(schema.eventSyncs.conferenceStatus, 'pending'),
          isNotNull(schema.eventSyncs.providerEventId),
          inArray(schema.appointments.status, ['pending_confirmation', 'confirmed', 'rescheduled']),
        ),
      )
      .limit(options.limit ?? 50),
  );
  const summary = { checked: 0, ready: 0, failed: 0 };
  for (const row of rows) {
    summary.checked += 1;
    try {
      const organizer = await resolveOrganizer(runtime, row.appointment.staffUserId);
      const result = await organizer.provider.getEvent(organizer.credentials, {
        calendarId: row.sync.providerCalendarId ?? organizer.calendarId,
        eventId: row.sync.providerEventId!,
      });
      const conference = mapConference(result.conference, true);
      if (conference.status === 'ready') summary.ready += 1;
      if (conference.status === 'failed') summary.failed += 1;
      await withActor(runtime.db, systemContext('calendar-reconcile'), async (tx) => {
        await tx
          .update(schema.eventSyncs)
          .set({
            etag: result.etag,
            sequence: result.sequence,
            conferenceStatus: conference.status,
            meetUrl: conference.meetUrl,
            lastSyncedAt: runtime.now(),
            lastErrorSanitized:
              conference.status === 'failed'
                ? 'Google reported the Meet conference request as failed; retry creates a new request id'
                : row.sync.lastErrorSanitized,
          })
          .where(eq(schema.eventSyncs.id, row.sync.id));
        await tx
          .update(schema.appointments)
          .set({ conferenceStatus: conference.status, meetingUrl: conference.meetUrl })
          .where(eq(schema.appointments.id, row.appointment.id));
      });
    } catch (err) {
      const message = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
      await withActor(runtime.db, systemContext('calendar-reconcile'), (tx) =>
        tx
          .update(schema.eventSyncs)
          .set({
            attempts: sql`${schema.eventSyncs.attempts} + 1`,
            lastErrorSanitized: message.slice(0, 500),
          })
          .where(eq(schema.eventSyncs.id, row.sync.id)),
      );
    }
  }
  return summary;
}

/** Re-watches channels about to expire. Skipped unless a public HTTPS receiver exists. */
export async function renewWatchChannels(
  runtime: CalendarRuntime,
  options: { pushAddress: string | null; force?: boolean },
): Promise<{ renewed: number; skipped: number }> {
  if (!options.pushAddress) return { renewed: 0, skipped: 0 };
  const info = await runtime.providerInfo();
  const connections = await withActor(runtime.db, systemContext('calendar-watch'), (tx) =>
    tx
      .select()
      .from(schema.calendarConnections)
      .where(
        and(
          eq(schema.calendarConnections.environment, runtime.environment),
          eq(schema.calendarConnections.status, 'connected'),
        ),
      ),
  );
  let renewed = 0;
  let skipped = 0;
  for (const connection of connections) {
    const channels = await withActor(runtime.db, systemContext('calendar-watch'), (tx) =>
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
    const healthy = channels.some((c) => !channelNeedsRenewal(c.expiration, runtime.now()));
    if (healthy && !options.force) {
      skipped += 1;
      continue;
    }
    try {
      const credentials = await runtime.credentialsFor(connection);
      const channelId = randomUUID();
      const token = createChannelToken();
      const result = await info.provider.watchEvents(credentials, {
        calendarId: connection.calendarId ?? 'primary',
        channelId,
        address: options.pushAddress,
        token,
        ttlSeconds: WATCH_CHANNEL_TTL_SECONDS,
      });
      await withActor(runtime.db, systemContext('calendar-watch'), async (tx) => {
        await tx.insert(schema.calendarWatchChannels).values({
          calendarConnectionId: connection.id,
          channelId: result.channelId,
          resourceId: result.resourceId,
          tokenHash: hashChannelToken(token),
          expiration: result.expiration,
          // Carry the incremental sync token forward so the new channel continues where the old one stopped.
          syncToken: channels[0]?.syncToken ?? null,
          status: 'active',
        });
        for (const old of channels) {
          await tx
            .update(schema.calendarWatchChannels)
            .set({ status: 'stopped' })
            .where(eq(schema.calendarWatchChannels.id, old.id));
        }
      });
      for (const old of channels) {
        if (!old.resourceId) continue;
        try {
          await info.provider.stopChannel(credentials, {
            channelId: old.channelId,
            resourceId: old.resourceId,
          });
        } catch {
          // The old channel expires on its own; nothing else to do.
        }
      }
      renewed += 1;
    } catch (err) {
      if (err instanceof CalendarAuthError) {
        await markConnectionExpired(runtime.db, connection.id, err, runtime.now());
      }
      skipped += 1;
    }
  }
  return { renewed, skipped };
}

/**
 * Incremental sync after a push notification (or on demand). Compares what
 * Google returns with our copy and marks organiser-side edits/deletions as
 * conflicts for staff review; it never applies external times blindly.
 */
export async function processPush(
  runtime: CalendarRuntime,
  channelId: string,
): Promise<{ changes: number; conflicts: number; fullResync: boolean }> {
  const found = await withActor(runtime.db, systemContext('calendar-push'), (tx) =>
    tx
      .select({ channel: schema.calendarWatchChannels, connection: schema.calendarConnections })
      .from(schema.calendarWatchChannels)
      .innerJoin(
        schema.calendarConnections,
        eq(schema.calendarConnections.id, schema.calendarWatchChannels.calendarConnectionId),
      )
      .where(eq(schema.calendarWatchChannels.channelId, channelId)),
  );
  const row = found[0];
  if (!row) throw new NonRetryableJobError(`unknown watch channel ${channelId}`);
  const info = await runtime.providerInfo();
  const credentials = await runtime.credentialsFor(row.connection);
  const calendarId = row.connection.calendarId ?? 'primary';
  let syncToken: string | null = row.channel.syncToken;
  let fullResync = false;
  let pageToken: string | null = null;
  let changes = 0;
  let conflicts = 0;
  let nextSyncToken: string | null = null;
  const now = runtime.now();
  try {
    for (let guard = 0; guard < 100; guard += 1) {
      const page = await info.provider.listChanges(credentials, {
        calendarId,
        syncToken: pageToken ? null : syncToken,
        pageToken,
        timeMin:
          syncToken || pageToken ? null : new Date(now.getTime() - 7 * 24 * 3600_000).toISOString(),
      });
      if (page.fullResyncRequired) {
        // HTTP 410: the token expired. Drop it and start a full sync bounded by timeMin.
        fullResync = true;
        syncToken = null;
        pageToken = null;
        continue;
      }
      for (const item of page.items) {
        changes += 1;
        const [sync] = await withActor(runtime.db, systemContext('calendar-push'), (tx) =>
          tx
            .select({ sync: schema.eventSyncs, appointment: schema.appointments })
            .from(schema.eventSyncs)
            .innerJoin(
              schema.appointments,
              eq(schema.appointments.id, schema.eventSyncs.appointmentId),
            )
            .where(eq(schema.eventSyncs.providerEventId, item.id)),
        );
        if (!sync) continue;
        const appointment = sync.appointment;
        const active = ['pending_confirmation', 'confirmed', 'rescheduled'].includes(
          appointment.status,
        );
        let conflict: string | null = null;
        if (item.status === 'cancelled' && active && sync.sync.status !== 'cancelled') {
          conflict =
            'The organiser deleted this event in Google Calendar; confirm or rebook with the customer.';
        } else if (item.status !== 'cancelled' && item.start && item.end && active) {
          const drift =
            Math.abs(new Date(item.start).getTime() - appointment.startsAt.getTime()) > 60_000 ||
            Math.abs(new Date(item.end).getTime() - appointment.endsAt.getTime()) > 60_000;
          if (drift) {
            conflict = `The organiser moved this event in Google Calendar to ${item.start} – ${item.end}; the platform time was not changed.`;
          }
        }
        await withActor(runtime.db, systemContext('calendar-push'), async (tx) => {
          await tx
            .update(schema.eventSyncs)
            .set({
              etag: item.etag ?? sync.sync.etag,
              sequence: item.sequence ?? sync.sync.sequence,
              ...(conflict ? { status: 'conflict' as const, lastErrorSanitized: conflict } : {}),
            })
            .where(eq(schema.eventSyncs.id, sync.sync.id));
          if (conflict) {
            await tx
              .update(schema.appointments)
              .set({ calendarSyncStatus: 'conflict' })
              .where(eq(schema.appointments.id, appointment.id));
            await appendOutbox(tx, {
              eventType: 'appointment.sync_conflict',
              aggregateType: 'appointment',
              aggregateId: appointment.id,
              organizationId: appointment.organizationId,
              payload: {
                appointmentId: appointment.id,
                reason: conflict,
                staffUserId: appointment.staffUserId,
              },
            });
          }
        });
        if (conflict) conflicts += 1;
      }
      if (page.nextPageToken) {
        pageToken = page.nextPageToken;
        continue;
      }
      nextSyncToken = page.nextSyncToken;
      break;
    }
  } catch (err) {
    if (err instanceof CalendarAuthError) {
      await markConnectionExpired(runtime.db, row.connection.id, err, now);
      throw new NonRetryableJobError(`${err.message}; ${err.instructions}`);
    }
    throw err;
  }
  await withActor(runtime.db, systemContext('calendar-push'), (tx) =>
    tx
      .update(schema.calendarWatchChannels)
      .set({ syncToken: nextSyncToken ?? syncToken, lastNotificationAt: now })
      .where(eq(schema.calendarWatchChannels.id, row.channel.id)),
  );
  return { changes, conflicts, fullResync };
}

/** Emits `appointment.reminder_due` once per configured lead time per appointment. */
export async function scanReminders(db: Database, now: Date): Promise<number> {
  return withActor(db, systemContext('appointment-reminders'), async (tx) => {
    const [setting] = await tx
      .select({ value: schema.bookingSettings.value })
      .from(schema.bookingSettings)
      .where(eq(schema.bookingSettings.key, 'reminder_hours'));
    const hours = (Array.isArray(setting?.value) ? (setting!.value as unknown[]) : [24, 1]).filter(
      (h): h is number => typeof h === 'number' && h > 0,
    );
    if (hours.length === 0) return 0;
    const horizon = new Date(now.getTime() + Math.max(...hours) * 3600_000);
    const rows = await tx
      .select()
      .from(schema.appointments)
      .where(
        and(
          inArray(schema.appointments.status, ['confirmed', 'rescheduled']),
          gt(schema.appointments.startsAt, now),
          lte(schema.appointments.startsAt, horizon),
        ),
      );
    let emitted = 0;
    for (const row of rows) {
      const sent = new Set(Array.isArray(row.remindersSent) ? row.remindersSent : []);
      const due = hours.filter(
        (h) => row.startsAt.getTime() - now.getTime() <= h * 3600_000 && !sent.has(String(h)),
      );
      if (due.length === 0) continue;
      // Only the tightest lead time still due is sent, so a late scan never sends two reminders at once.
      const h = Math.min(...due);
      for (const d of due) sent.add(String(d));
      await appendOutbox(tx, {
        eventType: 'appointment.reminder_due',
        aggregateType: 'appointment',
        aggregateId: row.id,
        organizationId: row.organizationId,
        actorUserId: null,
        payload: {
          appointmentId: row.id,
          hoursBefore: h,
          startsAt: row.startsAt.toISOString(),
          email: row.guestEmail,
          phoneE164: row.guestPhoneE164,
          customerUserId: row.customerUserId,
          staffUserId: row.staffUserId,
          meetingUrl: row.conferenceStatus === 'ready' ? row.meetingUrl : null,
          channel: 'email',
          category: 'reminders',
        },
      });
      await tx
        .update(schema.appointments)
        .set({ remindersSent: [...sent] })
        .where(eq(schema.appointments.id, row.id));
      emitted += 1;
    }
    return emitted;
  });
}

function appointmentIdFrom(payload: unknown): string {
  const p = (payload ?? {}) as { appointmentId?: unknown; event?: { aggregateId?: unknown } };
  const id = typeof p.appointmentId === 'string' ? p.appointmentId : p.event?.aggregateId;
  if (typeof id !== 'string' || !id)
    throw new NonRetryableJobError('job payload lacks appointmentId');
  return id;
}

export function pushAddressFor(appUrl: string | undefined, appEnv: string): string | null {
  if (!appUrl) return null;
  // Google only delivers to HTTPS receivers on verified domains; development uses polling.
  if (!appUrl.startsWith('https://') && appEnv !== 'test') return null;
  return `${appUrl.replace(/\/+$/, '')}${CALENDAR_PUSH_PATH}`;
}

export function registerCalendarHandlers(runner: JobRunner): void {
  let runtime: CalendarRuntime | null = null;
  const getRuntime = (db: Database): CalendarRuntime => {
    runtime ??= createCalendarRuntime({
      db,
      appEnv: process.env.APP_ENV ?? 'development',
      appUrl: process.env.APP_URL ?? 'http://localhost:3000',
    });
    return runtime;
  };

  runner.register(CALENDAR_JOB_TYPES.syncEvent, async ({ db, job, log }) => {
    const payload = job.payload as { retryConference?: boolean };
    const result = await syncAppointmentEvent(getRuntime(db), appointmentIdFrom(job.payload), {
      retryConference: Boolean(payload?.retryConference),
    });
    log.info(result, 'calendar event synchronised');
  });

  runner.register(CALENDAR_JOB_TYPES.cancelEvent, async ({ db, job, log }) => {
    const result = await cancelAppointmentEvent(getRuntime(db), appointmentIdFrom(job.payload));
    log.info({ result }, 'calendar event cancelled');
  });

  runner.register(CALENDAR_JOB_TYPES.reconcileConferences, async ({ db, log }) => {
    const summary = await reconcilePendingConferences(getRuntime(db));
    if (summary.checked > 0) log.info(summary, 'pending Meet conferences reconciled');
  });

  runner.register(CALENDAR_JOB_TYPES.renewWatchChannels, async ({ db, log }) => {
    const rt = getRuntime(db);
    const summary = await renewWatchChannels(rt, {
      pushAddress: pushAddressFor(rt.appUrl, rt.appEnv),
    });
    if (summary.renewed > 0) log.info(summary, 'calendar watch channels renewed');
  });

  runner.register(CALENDAR_JOB_TYPES.processPush, async ({ db, job, log }) => {
    const channelId = (job.payload as { channelId?: unknown }).channelId;
    if (typeof channelId !== 'string')
      throw new NonRetryableJobError('job payload lacks channelId');
    const summary = await processPush(getRuntime(db), channelId);
    log.info(summary, 'calendar push processed');
  });

  runner.register(CALENDAR_JOB_TYPES.scanReminders, async ({ db, log }) => {
    const emitted = await scanReminders(db, new Date());
    if (emitted > 0) log.info({ emitted }, 'appointment reminders queued');
  });
}
