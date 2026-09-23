import { describe, expect, it } from 'vitest';
import { DevCalendarProvider } from './dev';
import { CalendarAuthError, CalendarConflictError } from './errors';
import { createPkcePair } from './state';
import type { CalendarCredentials, CreateEventInput } from './types';

async function connect(provider: DevCalendarProvider): Promise<CalendarCredentials> {
  const pkce = createPkcePair();
  const url = new URL(
    provider.buildAuthorizationUrl({
      redirectUri: 'http://localhost:3000/api/v1/admin/integrations/google/callback',
      state: 'signed-state',
      codeChallenge: pkce.codeChallenge,
      scopes: ['openid', 'email'],
    }),
  );
  expect(url.searchParams.get('state')).toBe('signed-state');
  return provider.exchangeCode({
    code: url.searchParams.get('code')!,
    codeVerifier: pkce.codeVerifier,
    redirectUri: url.origin + url.pathname,
  });
}

const booking: CreateEventInput = {
  calendarId: 'primary',
  appointmentId: 'appt-1',
  conferenceRequestId: 'req-1',
  summary: 'Consultation',
  start: '2026-11-02T08:00:00Z',
  end: '2026-11-02T08:30:00Z',
  timeZone: 'Africa/Lagos',
  attendees: [{ email: 'customer@example.com' }],
  sendUpdates: 'all',
};

describe('DevCalendarProvider', () => {
  it('refuses to run outside development/test', () => {
    expect(() => new DevCalendarProvider({ appEnv: 'production' })).toThrow(/development adapter/);
    expect(() => new DevCalendarProvider({ appEnv: 'staging' })).toThrow(/development adapter/);
  });

  it('completes a PKCE-checked code exchange and refreshes/revokes tokens', async () => {
    const provider = new DevCalendarProvider({ appEnv: 'test' });
    const tokens = await connect(provider);
    expect(tokens.refreshToken).toMatch(/^dev-refresh-/);
    expect(tokens.scope).toEqual(['openid', 'email']);
    const refreshed = await provider.refresh(tokens);
    expect(refreshed.accessToken).not.toBe(tokens.accessToken);
    await provider.revoke(tokens.refreshToken!);
    await expect(provider.refresh(tokens)).rejects.toBeInstanceOf(CalendarAuthError);

    const wrongVerifier = createPkcePair();
    const url = new URL(
      provider.buildAuthorizationUrl({
        redirectUri: 'http://localhost:3000/cb',
        state: 's',
        codeChallenge: createPkcePair().codeChallenge,
        scopes: ['openid'],
      }),
    );
    await expect(
      provider.exchangeCode({
        code: url.searchParams.get('code')!,
        codeVerifier: wrongVerifier.codeVerifier,
        redirectUri: 'x',
      }),
    ).rejects.toThrow(/PKCE/);
  });

  it('creates events with a deterministic Meet link only when ready, and dedupes retries', async () => {
    const provider = new DevCalendarProvider({ appEnv: 'test', simulateConference: 'ready' });
    const tokens = await connect(provider);
    const created = await provider.createEvent(tokens, booking);
    expect(created.conference.status).toBe('ready');
    expect(created.conference.meetUrl).toMatch(/^https:\/\/meet\.google\.com\/dev-[0-9a-f]{4}$/);
    expect(created.extendedPrivate.simplexdAppointmentId).toBe('appt-1');
    const retried = await provider.createEvent(tokens, booking);
    expect(retried.eventId).toBe(created.eventId);
    const busy = await provider.freeBusy(tokens, {
      calendarIds: ['primary', 'missing@example.com'],
      timeMin: '2026-11-02T00:00:00Z',
      timeMax: '2026-11-03T00:00:00Z',
    });
    expect(busy.busy).toEqual([
      { calendarId: 'primary', start: '2026-11-02T08:00:00.000Z', end: '2026-11-02T08:30:00.000Z' },
    ]);
    expect(busy.errors).toEqual([{ calendarId: 'missing@example.com', reason: 'notFound' }]);
  });

  it('keeps a pending conference pending until polled, and fails then succeeds with a new request id', async () => {
    const pending = new DevCalendarProvider({
      appEnv: 'test',
      simulateConference: 'pending',
      pendingPolls: 2,
    });
    const tokens = await connect(pending);
    const created = await pending.createEvent(tokens, booking);
    expect(created.conference).toMatchObject({
      status: 'pending',
      meetUrl: null,
      requestId: 'req-1',
    });
    const poll1 = await pending.getEvent(tokens, {
      calendarId: 'primary',
      eventId: created.eventId,
    });
    expect(poll1.conference.status).toBe('pending');
    const poll2 = await pending.getEvent(tokens, {
      calendarId: 'primary',
      eventId: created.eventId,
    });
    expect(poll2.conference.status).toBe('ready');
    expect(poll2.conference.meetUrl).toContain('meet.google.com/dev-');

    const failing = new DevCalendarProvider({ appEnv: 'test', simulateConference: 'failure' });
    const t2 = await connect(failing);
    const failed = await failing.createEvent(t2, booking);
    expect(failed.conference).toMatchObject({ status: 'failed', meetUrl: null });
    const sameId = await failing.updateEvent(t2, {
      calendarId: 'primary',
      eventId: failed.eventId,
      etag: failed.etag,
      patch: { conferenceRequestId: 'req-1' },
      sendUpdates: 'none',
    });
    expect(sameId.conference.status).toBe('failed');
    const retried = await failing.updateEvent(t2, {
      calendarId: 'primary',
      eventId: failed.eventId,
      etag: sameId.etag,
      patch: { conferenceRequestId: 'req-2' },
      sendUpdates: 'none',
    });
    expect(retried.conference).toMatchObject({ status: 'ready', requestId: 'req-2' });
  });

  it('raises a conflict on a stale etag and cancels idempotently', async () => {
    const provider = new DevCalendarProvider({ appEnv: 'test' });
    const tokens = await connect(provider);
    const created = await provider.createEvent(tokens, booking);
    const moved = await provider.updateEvent(tokens, {
      calendarId: 'primary',
      eventId: created.eventId,
      etag: created.etag,
      patch: { start: '2026-11-02T09:00:00Z', end: '2026-11-02T09:30:00Z' },
      sendUpdates: 'all',
    });
    expect(moved.etag).not.toBe(created.etag);
    expect(moved.sequence).toBe(1);
    await expect(
      provider.updateEvent(tokens, {
        calendarId: 'primary',
        eventId: created.eventId,
        etag: created.etag,
        patch: { summary: 'stale writer' },
        sendUpdates: 'none',
      }),
    ).rejects.toBeInstanceOf(CalendarConflictError);
    await expect(
      provider.cancelEvent(tokens, {
        calendarId: 'primary',
        eventId: created.eventId,
        etag: created.etag,
        sendUpdates: 'all',
      }),
    ).rejects.toBeInstanceOf(CalendarConflictError);
    expect(
      await provider.cancelEvent(tokens, {
        calendarId: 'primary',
        eventId: created.eventId,
        etag: moved.etag,
        sendUpdates: 'all',
      }),
    ).toEqual({ status: 'cancelled' });
    expect(
      await provider.cancelEvent(tokens, {
        calendarId: 'primary',
        eventId: created.eventId,
        etag: null,
        sendUpdates: 'all',
      }),
    ).toEqual({ status: 'already_gone' });
  });

  it('simulates watch channels and incremental sync with token expiry', async () => {
    const provider = new DevCalendarProvider({ appEnv: 'test' });
    const tokens = await connect(provider);
    const watch = await provider.watchEvents(tokens, {
      calendarId: 'primary',
      channelId: 'chan-1',
      address: 'https://app.example.com/api/v1/webhooks/google-calendar',
      token: 'secret-token',
      ttlSeconds: 3600,
    });
    expect(watch.resourceId).toMatch(/^dev-res-/);
    const headers = provider.simulateNotificationHeaders('chan-1');
    expect(headers['x-goog-channel-token']).toBe('secret-token');
    expect(headers['x-goog-resource-state']).toBe('exists');

    const full = await provider.listChanges(tokens, { calendarId: 'primary' });
    expect(full.items).toEqual([]);
    expect(full.nextSyncToken).toMatch(/^dev-sync-/);
    const created = await provider.createEvent(tokens, booking);
    const incremental = await provider.listChanges(tokens, {
      calendarId: 'primary',
      syncToken: full.nextSyncToken,
    });
    expect(incremental.items.map((i) => i.id)).toEqual([created.eventId]);
    expect(incremental.fullResyncRequired).toBe(false);
    const nothingNew = await provider.listChanges(tokens, {
      calendarId: 'primary',
      syncToken: incremental.nextSyncToken,
    });
    expect(nothingNew.items).toEqual([]);

    provider.expireSyncTokens();
    const expired = await provider.listChanges(tokens, {
      calendarId: 'primary',
      syncToken: incremental.nextSyncToken,
    });
    expect(expired.fullResyncRequired).toBe(true);
    const garbage = await provider.listChanges(tokens, {
      calendarId: 'primary',
      syncToken: 'not-ours',
    });
    expect(garbage.fullResyncRequired).toBe(true);
    await provider.stopChannel(tokens, { channelId: 'chan-1', resourceId: watch.resourceId });
    expect(() => provider.simulateNotificationHeaders('chan-1')).toThrow(/unknown dev channel/);
  });
});
