import { and, eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@simplexd/db';
import { connectTestDatabases, uniqueSuffix, type TestDatabases } from '@simplexd/db/testing';
import { DEFAULT_GOOGLE_SCOPES, type DevCalendarProvider } from '@simplexd/integrations/google';
import { staffIdentity } from '@/testing/identity';
import { viewerFromIdentity } from '@/server/appointments/access';
import { createBooking } from '@/server/appointments/book';
import { createHold } from '@/server/appointments/holds';
import { cancelAppointment, rescheduleAppointment, retryCalendarSync } from '@/server/appointments/mutate';
import { getAppointment } from '@/server/appointments/queries';
import {
  cancelAppointmentEvent,
  createCalendarRuntime,
  processPush,
  reconcilePendingConferences,
  renewWatchChannels,
  scanReminders,
  syncAppointmentEvent,
  type CalendarRuntime,
} from '../../../../worker/src/handlers/calendar';
import { checkConnection, getCalendarStatus, runTestBooking } from './admin';
import { completeConnect, disconnectConnection, startConnect } from './oauth';
import { handleCalendarPush } from './push';
import { credentialsForConnection, sharedDevProvider } from './runtime';

/**
 * Google Calendar / Meet synchronisation through the labelled development
 * adapter: booking → sync job → pending conference → reconcile → Meet URL,
 * one-shot Meet failure visible then retried with a new request id, etag
 * checked reschedule (incl. a stale etag), cancellation, the organiser OAuth
 * grant, watch channels + push processing and the admin test booking.
 */

let dbs: TestDatabases;
let runtime: CalendarRuntime;
let dev: DevCalendarProvider;
const sfx = uniqueSuffix();
const organiserId = `cal_org_${sfx}`;
const opsId = `cal_ops_${sfx}`;
const ops = () => staffIdentity({ userId: opsId, email: `${opsId}@example.test`, roles: ['operations_manager'] });
const organiser = () =>
  staffIdentity({ userId: organiserId, email: `${organiserId}@example.test`, roles: ['operations_manager'] });

function lagosSlot(offsetDays: number, hour: number, minute = 0): string {
  return DateTime.now()
    .setZone('Africa/Lagos')
    .plus({ days: offsetDays })
    .set({ hour, minute, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!;
}

async function bookGuest(offsetDays: number, hour: number) {
  const hold = await createHold(
    { kind: 'consultation', staffUserId: organiserId, start: lagosSlot(offsetDays, hour), customerTimeZone: 'Europe/London' },
    { identity: null },
  );
  return createBooking(
    {
      holdToken: hold.holdToken,
      guest: { name: 'Guest Person', email: `guest_${sfx}_${offsetDays}_${hour}@example.test`, phoneE164: '+2348012345678' },
      customerTimeZone: 'Europe/London',
      topic: 'Diligence',
    },
    { identity: null, correlationId: `cal-${sfx}` },
  );
}

async function syncRow(appointmentId: string) {
  const [row] = await dbs.owner.select().from(schema.eventSyncs).where(eq(schema.eventSyncs.appointmentId, appointmentId));
  return row!;
}

async function appointmentRow(appointmentId: string) {
  const [row] = await dbs.owner.select().from(schema.appointments).where(eq(schema.appointments.id, appointmentId));
  return row!;
}

beforeAll(async () => {
  dbs = connectTestDatabases();
  dev = sharedDevProvider('test');
  dev.setConferenceMode('ready');
  runtime = createCalendarRuntime({
    db: dbs.app,
    appEnv: 'test',
    appUrl: 'http://localhost:3000',
    devProvider: dev,
  });
  await dbs.owner.insert(schema.user).values([
    { id: organiserId, name: 'Calendar Organiser', email: `${organiserId}@example.test` },
    { id: opsId, name: 'Ops', email: `${opsId}@example.test` },
  ]);
  await dbs.owner.insert(schema.staffRoles).values([
    { userId: organiserId, role: 'operations_manager' },
    { userId: opsId, role: 'operations_manager' },
  ]);
  await dbs.owner.insert(schema.staffAvailability).values(
    [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      staffUserId: organiserId,
      weekday,
      startTime: '08:00',
      endTime: '18:00',
      timeZone: 'Africa/Lagos',
      kinds: ['consultation'],
    })),
  );
});

afterAll(async () => {
  await dbs.close();
});

describe('event sync and Meet lifecycle', () => {
  it('creates the event, keeps the Meet pending until Google confirms it, then exposes the link', async () => {
    dev.setConferenceMode('pending');
    const booked = await bookGuest(3, 9);
    const result = await syncAppointmentEvent(runtime, booked.id);
    expect(result.outcome).toBe('created');
    expect(result.conferenceStatus).toBe('pending');
    let sync = await syncRow(booked.id);
    expect(sync.providerEventId).toBeTruthy();
    expect(sync.etag).toBeTruthy();
    expect(sync.status).toBe('created');
    expect(sync.conferenceStatus).toBe('pending');
    let dto = await getAppointment(viewerFromIdentity(ops()), booked.id);
    expect(dto.calendarSyncStatus).toBe('synced');
    expect(dto.conferenceStatus).toBe('pending');
    expect(dto.meetingUrl).toBeNull(); // never invented
    expect(dto.sync?.provider).toBe('dev');

    const reconciled = await reconcilePendingConferences(runtime);
    expect(reconciled.checked).toBeGreaterThanOrEqual(1);
    sync = await syncRow(booked.id);
    expect(sync.conferenceStatus).toBe('ready');
    expect(sync.meetUrl).toMatch(/^https:\/\/meet\.google\.com\/dev-/);
    dto = await getAppointment(viewerFromIdentity(ops()), booked.id);
    expect(dto.meetingUrl).toBe(sync.meetUrl);
    expect(dto.calendarNote).toContain('Development adapter');

    // Re-running the same sync version is idempotent: same event, no duplicate.
    const again = await syncAppointmentEvent(runtime, booked.id);
    expect(again.outcome).toBe('updated');
    expect((await syncRow(booked.id)).providerEventId).toBe(sync.providerEventId);
    dev.setConferenceMode('ready');
  });

  it('shows a one-shot Meet failure and succeeds on retry with a new request id, without a duplicate event', async () => {
    dev.setConferenceMode('failure');
    const booked = await bookGuest(4, 10);
    const first = await syncAppointmentEvent(runtime, booked.id);
    expect(first.conferenceStatus).toBe('failed');
    let sync = await syncRow(booked.id);
    const originalRequestId = sync.conferenceRequestId;
    let dto = await getAppointment(viewerFromIdentity(ops()), booked.id);
    expect(dto.conferenceStatus).toBe('failed');
    expect(dto.meetingUrl).toBeNull();
    expect(dto.sync?.lastError).toMatch(/Meet conference request as failed/);
    expect(dto.calendarNote).toMatch(/could not create the Meet link/);

    // Staff retry: enqueues a job with retryConference, worker asks for a new conference.
    const requested = await retryCalendarSync(viewerFromIdentity(ops()), booked.id, { correlationId: 'retry' });
    expect(requested.calendarSyncStatus).toBe('pending');
    const jobs = await dbs.owner
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.type, 'calendar.sync_event'), eq(schema.jobs.status, 'pending')));
    const retryJob = jobs.find((j) => (j.payload as { appointmentId: string; retryConference: boolean }).appointmentId === booked.id && (j.payload as { retryConference: boolean }).retryConference);
    expect(retryJob).toBeDefined();
    const second = await syncAppointmentEvent(runtime, booked.id, { retryConference: true });
    expect(second.conferenceStatus).toBe('ready');
    sync = await syncRow(booked.id);
    expect(sync.conferenceRequestId).not.toBe(originalRequestId);
    expect(sync.meetUrl).toMatch(/^https:\/\/meet\.google\.com\//);
    dto = await getAppointment(viewerFromIdentity(ops()), booked.id);
    expect(dto.meetingUrl).toBe(sync.meetUrl);
    // Exactly one provider event for this appointment.
    const changes = await dev.listChanges(runtime.devCredentials(), { calendarId: 'primary' });
    const mine = changes.items.filter((e) => e.extendedPrivate['simplexdAppointmentId'] === booked.id);
    expect(mine).toHaveLength(1);
    dev.setConferenceMode('ready');
  });

  it('updates the event on reschedule with the stored etag and recovers from a stale etag', async () => {
    const booked = await bookGuest(5, 11);
    await syncAppointmentEvent(runtime, booked.id);
    const before = await syncRow(booked.id);
    const hold = await createHold(
      { kind: 'consultation', staffUserId: organiserId, start: lagosSlot(5, 15), customerTimeZone: 'Europe/London' },
      { identity: null },
    );
    const rescheduled = await rescheduleAppointment(
      { kind: 'id', viewer: viewerFromIdentity(ops()), id: booked.id },
      { holdToken: hold.holdToken },
      { correlationId: 'resched' },
    );
    expect(rescheduled.calendarSyncStatus).toBe('pending');
    const result = await syncAppointmentEvent(runtime, booked.id);
    expect(result.outcome).toBe('updated');
    const after = await syncRow(booked.id);
    expect(after.providerEventId).toBe(before.providerEventId);
    expect(after.etag).not.toBe(before.etag);
    expect(after.sequence).toBeGreaterThan(before.sequence ?? 0);
    const event = await dev.getEvent(runtime.devCredentials(), { calendarId: 'primary', eventId: after.providerEventId! });
    expect(event.start).toBe(hold.start);
    expect((await appointmentRow(booked.id)).calendarSyncStatus).toBe('synced');

    // Simulate the organiser editing the event in Google: our etag is now stale (412).
    await dbs.owner.update(schema.eventSyncs).set({ etag: '"dev-etag-0"' }).where(eq(schema.eventSyncs.id, after.id));
    const hold2 = await createHold(
      { kind: 'consultation', staffUserId: organiserId, start: lagosSlot(5, 16), customerTimeZone: 'Europe/London' },
      { identity: null },
    );
    await rescheduleAppointment(
      { kind: 'id', viewer: viewerFromIdentity(ops()), id: booked.id },
      { holdToken: hold2.holdToken },
      { correlationId: 'resched2' },
    );
    const recovered = await syncAppointmentEvent(runtime, booked.id);
    expect(recovered.outcome).toBe('updated');
    const fresh = await dev.getEvent(runtime.devCredentials(), { calendarId: 'primary', eventId: after.providerEventId! });
    expect(fresh.start).toBe(hold2.start);
    expect((await syncRow(booked.id)).etag).toBe(fresh.etag);
  });

  it('deletes the event on cancellation and reports already-gone events as cancelled', async () => {
    const booked = await bookGuest(6, 12);
    await syncAppointmentEvent(runtime, booked.id);
    const sync = await syncRow(booked.id);
    const cancelled = await cancelAppointment(
      { kind: 'id', viewer: viewerFromIdentity(ops()), id: booked.id },
      { reason: 'customer request' },
      { correlationId: 'cancel' },
    );
    expect(cancelled.calendarSyncStatus).toBe('pending');
    const cancelJobs = await dbs.owner
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.dedupeKey, `calendar.cancel_event:${booked.id}`));
    expect(cancelJobs).toHaveLength(1);
    expect(await cancelAppointmentEvent(runtime, booked.id)).toBe('cancelled');
    const event = await dev.getEvent(runtime.devCredentials(), { calendarId: 'primary', eventId: sync.providerEventId! });
    expect(event.status).toBe('cancelled');
    expect((await appointmentRow(booked.id)).calendarSyncStatus).toBe('cancelled');
    expect((await syncRow(booked.id)).status).toBe('cancelled');
    expect(await cancelAppointmentEvent(runtime, booked.id)).toBe('already_gone');
    // A sync job that arrives after cancellation also ends up cancelling.
    expect((await syncAppointmentEvent(runtime, booked.id)).outcome).toBe('cancelled');
  });

  it('emits reminder events once per lead time', async () => {
    const booked = await bookGuest(2, 9);
    const start = new Date(booked.startsAt).getTime();
    const twentyThreeHoursBefore = new Date(start - 23 * 3600_000);
    expect(await scanReminders(dbs.app, twentyThreeHoursBefore)).toBeGreaterThanOrEqual(1);
    expect(await scanReminders(dbs.app, twentyThreeHoursBefore)).toBe(0);
    const outbox = await dbs.owner
      .select()
      .from(schema.outboxEvents)
      .where(and(eq(schema.outboxEvents.aggregateId, booked.id), eq(schema.outboxEvents.eventType, 'appointment.reminder_due')));
    expect(outbox).toHaveLength(1);
    expect((outbox[0]!.payload as { hoursBefore: number }).hoursBefore).toBe(24);
    expect((await appointmentRow(booked.id)).remindersSent).toEqual(['24']);
    // One hour before: the 1h reminder goes out too.
    expect(await scanReminders(dbs.app, new Date(start - 30 * 60_000))).toBe(1);
    expect((await appointmentRow(booked.id)).remindersSent).toEqual(['24', '1']);
  });
});

describe('organiser connection, push notifications and admin tools', () => {
  let connectionId: string;
  let channelId: string;

  it('connects an organiser with PKCE + signed state and stores encrypted tokens', async () => {
    const start = await startConnect(organiser());
    expect(start.adapter).toBe('dev');
    const url = new URL(start.authorizationUrl);
    const result = await completeConnect(organiser(), {
      code: url.searchParams.get('code'),
      state: url.searchParams.get('state'),
      error: null,
      cookieValue: start.cookieValue,
      correlationId: 'oauth',
    });
    connectionId = result.connection.id;
    expect(result.connection.status).toBe('connected');
    expect(result.missingScopes).toEqual([]);
    expect(result.connection.scopes).toEqual([...DEFAULT_GOOGLE_SCOPES]);
    expect(result.connection.accountEmail).toBe('organiser@dev.simplexd.local');
    expect(result.connection.calendarId).toBe('primary');
    const [row] = await dbs.owner.select().from(schema.calendarConnections).where(eq(schema.calendarConnections.id, connectionId));
    expect(row!.refreshTokenSecretId).toBeTruthy();
    const secrets = await dbs.owner
      .select()
      .from(schema.secretReferences)
      .where(eq(schema.secretReferences.id, row!.refreshTokenSecretId!));
    expect(secrets[0]!.provider).toBe('google_workspace');
    expect(secrets[0]!.ciphertext.toString('utf8')).not.toContain('dev-refresh');
    const creds = await credentialsForConnection(row!);
    expect(creds.refreshToken).toMatch(/^dev-refresh-/);

    // Replaying with a mismatched cookie/state is refused.
    await expect(
      completeConnect(ops(), {
        code: url.searchParams.get('code'),
        state: url.searchParams.get('state'),
        error: null,
        cookieValue: start.cookieValue,
        correlationId: 'oauth2',
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('reports status honestly and runs a real test booking through the provider', async () => {
    const status = await getCalendarStatus(ops());
    expect(status.adapter).toBe('dev');
    expect(status.clientConfigured).toBe(false);
    expect(status.redirectUri).toBe('http://localhost:3000/api/v1/calendar/callback');
    const conn = status.connections.find((c) => c.id === connectionId);
    expect(conn?.status).toBe('connected');
    expect(conn?.organizer.userId).toBe(organiserId);
    const checked = await checkConnection(ops(), connectionId, { correlationId: 'check' });
    expect(checked.lastCheckOk).toBe(true);
    expect(checked.status).toBe('connected');
    const test = await runTestBooking(organiser(), { correlationId: 'test-booking' });
    expect(test.ok).toBe(true);
    expect(test.adapter).toBe('dev');
    expect(test.connectionId).toBe(connectionId);
    expect(test.deleted).toBe(true);
    expect(test.conferenceStatus).toBe('ready');
    expect(test.message).toContain('Development adapter');
  });

  it('creates a watch channel, validates push notifications and reconciles organiser-side changes', async () => {
    const renewed = await renewWatchChannels(runtime, {
      pushAddress: 'http://localhost:3000/api/v1/calendar/push',
      force: true,
    });
    expect(renewed.renewed).toBe(1);
    const [channel] = await dbs.owner
      .select()
      .from(schema.calendarWatchChannels)
      .where(and(eq(schema.calendarWatchChannels.calendarConnectionId, connectionId), eq(schema.calendarWatchChannels.status, 'active')));
    channelId = channel!.channelId;
    expect(channel!.tokenHash).toHaveLength(64);

    // Sync message: acknowledged, no job. Exists message: job queued.
    const syncHeaders = dev.simulateNotificationHeaders(channelId, 'sync');
    expect(await handleCalendarPush(syncHeaders, 'push-1')).toMatchObject({ status: 200, action: 'acknowledged' });
    const okHeaders = dev.simulateNotificationHeaders(channelId, 'exists');
    expect(await handleCalendarPush(okHeaders, 'push-2')).toMatchObject({ status: 200, action: 'queued' });
    expect(await handleCalendarPush({ ...okHeaders, 'x-goog-channel-token': 'wrong' }, 'push-3')).toMatchObject({ status: 403 });
    expect(await handleCalendarPush({ ...okHeaders, 'x-goog-channel-id': 'unknown' }, 'push-4')).toMatchObject({ status: 404 });
    const pushJobs = await dbs.owner.select().from(schema.jobs).where(eq(schema.jobs.type, 'calendar.process_push'));
    expect(pushJobs.some((j) => (j.payload as { channelId: string }).channelId === channelId)).toBe(true);

    // Initial sync establishes a token; then an organiser-side deletion becomes a conflict.
    const initial = await processPush(runtime, channelId);
    expect(initial.fullResync).toBe(false);
    const [afterInitial] = await dbs.owner.select().from(schema.calendarWatchChannels).where(eq(schema.calendarWatchChannels.channelId, channelId));
    expect(afterInitial!.syncToken).toMatch(/^dev-sync-/);

    const booked = await bookGuest(7, 13);
    await syncAppointmentEvent(runtime, booked.id);
    const sync = await syncRow(booked.id);
    await dev.cancelEvent(runtime.devCredentials(), { calendarId: 'primary', eventId: sync.providerEventId!, etag: null, sendUpdates: 'none' });
    const second = await processPush(runtime, channelId);
    expect(second.conflicts).toBe(1);
    const conflicted = await getAppointment(viewerFromIdentity(ops()), booked.id);
    expect(conflicted.calendarSyncStatus).toBe('conflict');
    expect(conflicted.sync?.lastError).toMatch(/deleted this event/);
    expect(conflicted.calendarNote).toMatch(/staff review/);

    // Expired sync token (410) → full resync, still no crash and a fresh token stored.
    dev.expireSyncTokens();
    const third = await processPush(runtime, channelId);
    expect(third.fullResync).toBe(true);
    const [afterResync] = await dbs.owner.select().from(schema.calendarWatchChannels).where(eq(schema.calendarWatchChannels.channelId, channelId));
    expect(afterResync!.syncToken).toMatch(/^dev-sync-/);
  });

  it('marks the connection expired on invalid_grant and shows reconnect instructions; disconnect retires secrets', async () => {
    const [row] = await dbs.owner.select().from(schema.calendarConnections).where(eq(schema.calendarConnections.id, connectionId));
    const creds = await credentialsForConnection(row!);
    await dev.revoke(creds.accessToken);
    await dev.revoke(creds.refreshToken!);
    const booked = await bookGuest(8, 9);
    await expect(syncAppointmentEvent(runtime, booked.id)).rejects.toMatchObject({ name: 'NonRetryableJobError' });
    const failed = await getAppointment(viewerFromIdentity(ops()), booked.id);
    expect(failed.calendarSyncStatus).toBe('failed');
    expect(failed.sync?.attempts).toBe(1);
    expect(failed.sync?.lastError).toMatch(/invalid_grant/);
    const status = await getCalendarStatus(ops());
    const conn = status.connections.find((c) => c.id === connectionId);
    expect(conn?.status).toBe('expired');
    expect(conn?.remedy).toMatch(/reconnect/i);
    expect(status.syncSummary.failed).toBeGreaterThanOrEqual(1);

    const disconnected = await disconnectConnection(ops(), connectionId, { correlationId: 'disc' });
    expect(disconnected.status).toBe('disconnected');
    const secrets = await dbs.owner
      .select()
      .from(schema.secretReferences)
      .where(eq(schema.secretReferences.id, row!.refreshTokenSecretId!));
    expect(secrets[0]!.retiredAt).not.toBeNull();
    // With no usable connection the development adapter takes over again and the failed sync can be retried.
    const retried = await syncAppointmentEvent(runtime, booked.id);
    expect(retried.outcome).toBe('created');
  });
});
