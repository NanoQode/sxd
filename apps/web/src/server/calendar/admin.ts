import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  ApiError,
  type CalendarConnectionDto,
  type CalendarStatusDto,
  type TestBookingResult,
} from '@simplexd/contracts';
import { getDb, schema, systemContext, withActor } from '@simplexd/db';
import {
  CalendarAuthError,
  CalendarProviderError,
  DEFAULT_GOOGLE_SCOPES,
  RECONNECT_INSTRUCTIONS,
  missingScopes,
  sanitizeErrorMessage,
  type CalendarProvider,
} from '@simplexd/integrations/google';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { env } from '@/lib/env';
import {
  calendarEnvironment,
  credentialsForConnection,
  getCalendarProviderInfo,
  pushAddress,
  redirectUri,
  resolveOrganizer,
  type ConnectionRow,
} from './runtime';

/**
 * Admin console read models and actions for the Google Workspace connection.
 * "Configured" (client id/secret saved) and "connected" (an organiser grant
 * whose last check succeeded) are reported separately, and a test booking
 * creates and deletes a real event through the active provider.
 */

export async function toConnectionDto(row: ConnectionRow): Promise<CalendarConnectionDto> {
  const [organizer, watch] = await withActor(
    getDb(),
    systemContext('calendar-admin'),
    async (tx) => {
      const [user] = await tx
        .select({ name: schema.user.name, email: schema.user.email })
        .from(schema.user)
        .where(eq(schema.user.id, row.organizerUserId));
      const [channel] = await tx
        .select()
        .from(schema.calendarWatchChannels)
        .where(
          and(
            eq(schema.calendarWatchChannels.calendarConnectionId, row.id),
            eq(schema.calendarWatchChannels.status, 'active'),
          ),
        )
        .orderBy(desc(schema.calendarWatchChannels.createdAt))
        .limit(1);
      return [user ?? null, channel ?? null] as const;
    },
  );
  const missing =
    row.status === 'disconnected' ? [] : missingScopes(row.scopes, DEFAULT_GOOGLE_SCOPES);
  return {
    id: row.id,
    provider: row.provider,
    environment: row.environment,
    organizer: {
      userId: row.organizerUserId,
      name: organizer?.name ?? 'unknown user',
      email: organizer?.email ?? '',
    },
    accountEmail: row.accountEmail,
    calendarId: row.calendarId,
    scopes: row.scopes,
    missingScopes: missing,
    status: row.status,
    accessTokenExpiresAt: row.accessTokenExpiresAt?.toISOString() ?? null,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastCheckOk: row.lastCheckOk,
    lastError: row.lastErrorSanitized,
    remedy:
      row.status === 'expired'
        ? RECONNECT_INSTRUCTIONS
        : row.status === 'degraded' && missing.length > 0
          ? 'Reconnect the organiser and accept every requested permission.'
          : row.status === 'disconnected'
            ? 'Connect an organiser from Admin → Integrations → Google Workspace.'
            : null,
    connectedAt: row.connectedAt?.toISOString() ?? null,
    disconnectedAt: row.disconnectedAt?.toISOString() ?? null,
    watch: watch
      ? {
          channelId: watch.channelId,
          expiration: watch.expiration?.toISOString() ?? null,
          status: watch.status,
          lastNotificationAt: watch.lastNotificationAt?.toISOString() ?? null,
        }
      : null,
  };
}

export async function getCalendarStatus(_identity: RequestIdentity): Promise<CalendarStatusDto> {
  const environment = calendarEnvironment();
  let adapter: 'google' | 'dev' | null = null;
  let clientConfigured = false;
  let message: string;
  try {
    const info = await getCalendarProviderInfo();
    adapter = info.adapter;
    clientConfigured = info.clientConfigured;
    message =
      info.adapter === 'dev'
        ? 'Development calendar adapter (simulated; not Google). Meet links are placeholders and do not open meetings.'
        : 'Google Calendar adapter active. A saved client ID/secret is not a connected calendar: check the organiser grant below.';
  } catch (err) {
    message =
      err instanceof Error ? sanitizeErrorMessage(err.message) : 'calendar provider unavailable';
  }
  const rows = await withActor(getDb(), systemContext('calendar-admin'), (tx) =>
    tx
      .select()
      .from(schema.calendarConnections)
      .where(eq(schema.calendarConnections.environment, environment))
      .orderBy(desc(schema.calendarConnections.connectedAt)),
  );
  const connections: CalendarConnectionDto[] = [];
  for (const row of rows) connections.push(await toConnectionDto(row));
  const counts = await withActor(getDb(), systemContext('calendar-admin'), (tx) =>
    tx.execute<{ key: string; n: string }>(sql`
      SELECT 'pending' AS key, count(*)::text AS n FROM appointments WHERE calendar_sync_status = 'pending' AND status IN ('pending_confirmation','confirmed','rescheduled')
      UNION ALL SELECT 'failed', count(*)::text FROM appointments WHERE calendar_sync_status = 'failed' AND status IN ('pending_confirmation','confirmed','rescheduled')
      UNION ALL SELECT 'conflict', count(*)::text FROM appointments WHERE calendar_sync_status = 'conflict' AND status IN ('pending_confirmation','confirmed','rescheduled')
      UNION ALL SELECT 'conferencePending', count(*)::text FROM appointments WHERE conference_status = 'pending' AND status IN ('pending_confirmation','confirmed','rescheduled')
      UNION ALL SELECT 'conferenceFailed', count(*)::text FROM appointments WHERE conference_status = 'failed' AND status IN ('pending_confirmation','confirmed','rescheduled')
    `),
  );
  const summary = { pending: 0, failed: 0, conflict: 0, conferencePending: 0, conferenceFailed: 0 };
  for (const r of counts.rows) (summary as Record<string, number>)[r.key] = Number(r.n);
  return {
    adapter,
    clientConfigured,
    environment,
    redirectUri: redirectUri(),
    pushAddress: pushAddress(),
    connections,
    syncSummary: summary,
    message,
  };
}

/** Runs a live token/calendar check and records the honest result on the connection. */
export async function checkConnection(
  identity: RequestIdentity,
  connectionId: string,
  options: { correlationId: string; now?: Date },
): Promise<CalendarConnectionDto> {
  const now = options.now ?? new Date();
  const [connection] = await withActor(getDb(), systemContext(options.correlationId), (tx) =>
    tx
      .select()
      .from(schema.calendarConnections)
      .where(eq(schema.calendarConnections.id, connectionId)),
  );
  if (!connection) throw new ApiError('not_found', 'calendar connection not found');
  if (connection.status === 'disconnected' || connection.status === 'disabled') {
    return toConnectionDto(connection);
  }
  const info = await getCalendarProviderInfo();
  let patch: Partial<typeof schema.calendarConnections.$inferInsert>;
  try {
    const credentials = await credentialsForConnection(connection);
    const result = await info.provider.testConnection(credentials);
    const missing = missingScopes(connection.scopes, DEFAULT_GOOGLE_SCOPES);
    patch = {
      lastCheckedAt: result.checkedAt,
      lastCheckOk: result.ok,
      lastErrorSanitized: result.ok
        ? missing.length > 0
          ? `missing scopes: ${missing.join(', ')}`
          : null
        : result.message,
      status: result.ok
        ? missing.length > 0
          ? 'degraded'
          : 'connected'
        : result.reconnectRequired
          ? 'expired'
          : 'degraded',
      accountEmail: result.accountEmail ?? connection.accountEmail,
    };
  } catch (err) {
    const auth = err instanceof CalendarAuthError;
    patch = {
      lastCheckedAt: now,
      lastCheckOk: false,
      status: auth ? 'expired' : 'degraded',
      lastErrorSanitized: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
    };
  }
  const [updated] = await withActor(getDb(), systemContext(options.correlationId), async (tx) => {
    const rows = await tx
      .update(schema.calendarConnections)
      .set(patch)
      .where(eq(schema.calendarConnections.id, connection.id))
      .returning();
    await recordAudit(tx, identity, {
      action: 'calendar.connection_checked',
      entityType: 'calendar_connection',
      entityId: connection.id,
      after: { status: patch.status, ok: patch.lastCheckOk },
      correlationId: options.correlationId,
    });
    return rows;
  });
  return toConnectionDto(updated!);
}

/**
 * Creates a short real event (with a Meet request) through the active
 * provider, reads it back and deletes it again, reporting exactly what the
 * provider returned. Never persists an appointment.
 */
export async function runTestBooking(
  identity: RequestIdentity,
  options: { correlationId: string; now?: Date; provider?: CalendarProvider },
): Promise<TestBookingResult> {
  const now = options.now ?? new Date();
  const staffUserId = identity.session?.user.id ?? null;
  const organizer = await resolveOrganizer(staffUserId);
  if (!organizer) {
    throw new ApiError(
      'provider_not_configured',
      'No connected Google organiser. Connect one from Admin → Integrations → Google Workspace before running a test booking.',
    );
  }
  const provider = options.provider ?? organizer.provider;
  const start = new Date(now.getTime() + 60 * 60_000);
  const end = new Date(start.getTime() + 15 * 60_000);
  const testId = `test-${randomUUID()}`;
  const result: TestBookingResult = {
    ok: false,
    adapter: organizer.adapter,
    connectionId: organizer.connection?.id ?? null,
    eventId: null,
    htmlLink: null,
    conferenceStatus: 'none',
    meetUrl: null,
    deleted: false,
    message: '',
    checkedAt: now.toISOString(),
  };
  try {
    const created = await provider.createEvent(organizer.credentials, {
      calendarId: organizer.calendarId,
      appointmentId: testId,
      conferenceRequestId: randomUUID(),
      summary: 'SimplexD test booking (safe to delete)',
      description: `Created by ${identity.session?.user.email ?? 'admin'} from the SimplexD admin console to verify the calendar connection.`,
      start: start.toISOString(),
      end: end.toISOString(),
      timeZone: env().BUSINESS_TIME_ZONE,
      attendees: [],
      sendUpdates: 'none',
      conference: true,
      privateProps: { simplexdKind: 'test_booking' },
    });
    result.eventId = created.eventId;
    result.htmlLink = created.htmlLink;
    let conference = created.conference;
    if (conference.status === 'pending') {
      const fetched = await provider.getEvent(organizer.credentials, {
        calendarId: organizer.calendarId,
        eventId: created.eventId,
      });
      conference = fetched.conference;
    }
    result.conferenceStatus = conference.status;
    result.meetUrl = conference.status === 'ready' ? conference.meetUrl : null;
    const cancelled = await provider.cancelEvent(organizer.credentials, {
      calendarId: organizer.calendarId,
      eventId: created.eventId,
      etag: null,
      sendUpdates: 'none',
    });
    result.deleted = cancelled.status === 'cancelled' || cancelled.status === 'already_gone';
    result.ok = result.deleted;
    result.message =
      organizer.adapter === 'dev'
        ? `Development adapter: simulated event ${created.eventId} created and deleted; Meet ${conference.status} (placeholder link, not a real meeting).`
        : `Event ${created.eventId} created on ${organizer.calendarId} and deleted; Meet conference ${conference.status}${
            conference.status === 'pending'
              ? ' (Google is still preparing it; production bookings are polled until ready)'
              : ''
          }.`;
  } catch (err) {
    result.message = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
    if (err instanceof CalendarAuthError) {
      result.message = `${result.message}. ${err.instructions}`;
      if (organizer.connection) {
        await withActor(getDb(), systemContext(options.correlationId), (tx) =>
          tx
            .update(schema.calendarConnections)
            .set({
              status: 'expired',
              lastCheckedAt: now,
              lastCheckOk: false,
              lastErrorSanitized: result.message,
            })
            .where(eq(schema.calendarConnections.id, organizer.connection!.id)),
        );
      }
    } else if (err instanceof CalendarProviderError && organizer.connection) {
      await withActor(getDb(), systemContext(options.correlationId), (tx) =>
        tx
          .update(schema.calendarConnections)
          .set({ lastCheckedAt: now, lastCheckOk: false, lastErrorSanitized: result.message })
          .where(eq(schema.calendarConnections.id, organizer.connection!.id)),
      );
    }
  }
  if (result.ok && organizer.connection) {
    await withActor(getDb(), systemContext(options.correlationId), (tx) =>
      tx
        .update(schema.calendarConnections)
        .set({ lastCheckedAt: now, lastCheckOk: true, lastErrorSanitized: null })
        .where(
          and(
            eq(schema.calendarConnections.id, organizer.connection!.id),
            inArray(schema.calendarConnections.status, ['connected', 'degraded']),
          ),
        ),
    );
  }
  await withActor(getDb(), systemContext(options.correlationId), (tx) =>
    recordAudit(tx, identity, {
      action: 'calendar.test_booking',
      entityType: 'calendar_connection',
      entityId: organizer.connection?.id ?? null,
      after: {
        ok: result.ok,
        adapter: result.adapter,
        eventId: result.eventId,
        conferenceStatus: result.conferenceStatus,
        deleted: result.deleted,
      },
      correlationId: options.correlationId,
    }),
  );
  return result;
}
