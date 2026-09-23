import { describe, expect, it, vi } from 'vitest';
import type { calendar_v3 } from 'googleapis/build/src/apis/calendar/index.js';
import { CalendarAuthError, CalendarConflictError, CalendarProviderError } from './errors';
import {
  GoogleCalendarProvider,
  deterministicEventId,
  emailFromIdToken,
  mapGoogleError,
  parseConference,
  type CalendarApi,
  type GenerateAuthUrlOptions,
  type OAuthClientLike,
  type OAuthCredentials,
} from './google';
import { createCalendarProvider } from './factory';
import type { CalendarCredentials } from './types';

function idToken(email: string): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64({ email, email_verified: true })}.sig`;
}

function gaxiosError(status: number, data?: unknown, message = `HTTP ${status}`): Error {
  return Object.assign(new Error(message), { response: { status, data }, status, code: status });
}

interface OAuthStub extends OAuthClientLike {
  emitTokens(tokens: OAuthCredentials): void;
  generateAuthUrl: ReturnType<typeof vi.fn<(opts?: GenerateAuthUrlOptions) => string>>;
  getToken: ReturnType<typeof vi.fn<OAuthClientLike['getToken']>>;
  refreshAccessToken: ReturnType<typeof vi.fn<OAuthClientLike['refreshAccessToken']>>;
  revokeToken: ReturnType<typeof vi.fn<OAuthClientLike['revokeToken']>>;
}

function oauthStub(): OAuthStub {
  const listeners: Array<(tokens: OAuthCredentials) => void> = [];
  const stub: OAuthStub = {
    credentials: {},
    generateAuthUrl: vi.fn((opts?: GenerateAuthUrlOptions) => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(opts ?? {})) {
        if (v !== undefined) params.set(k, Array.isArray(v) ? v.join(' ') : String(v));
      }
      return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    }),
    getToken: vi.fn(async () => ({
      tokens: {
        access_token: 'ya29.first',
        refresh_token: '1//refresh-first',
        expiry_date: 1_800_000_000_000,
        scope: 'openid email https://www.googleapis.com/auth/calendar.events.owned',
        id_token: idToken('organiser@example.com'),
      },
    })),
    setCredentials(credentials) {
      stub.credentials = credentials;
    },
    refreshAccessToken: vi.fn(async () => ({
      credentials: { access_token: 'ya29.refreshed', expiry_date: 1_800_003_600_000 },
    })),
    revokeToken: vi.fn(async () => ({})),
    on(_event, listener) {
      listeners.push(listener);
    },
    emitTokens(tokens) {
      for (const listener of listeners) listener(tokens);
    },
  };
  return stub;
}

const eventFixture: calendar_v3.Schema$Event = {
  id: 'evt-1',
  etag: '"etag-1"',
  sequence: 0,
  status: 'confirmed',
  htmlLink: 'https://www.google.com/calendar/event?eid=1',
  start: { dateTime: '2026-11-02T08:00:00Z', timeZone: 'Africa/Lagos' },
  end: { dateTime: '2026-11-02T08:30:00Z', timeZone: 'Africa/Lagos' },
  extendedProperties: { private: { simplexdAppointmentId: 'appt-1' } },
  conferenceData: {
    createRequest: {
      requestId: 'req-1',
      conferenceSolutionKey: { type: 'hangoutsMeet' },
      status: { statusCode: 'pending' },
    },
  },
};

function calendarStub() {
  const insert = vi.fn<CalendarApi['events']['insert']>(async () => ({ data: eventFixture }));
  const get = vi.fn<CalendarApi['events']['get']>(async () => ({
    data: {
      ...eventFixture,
      conferenceData: {
        createRequest: { requestId: 'req-1', status: { statusCode: 'success' } },
        entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }],
      },
    },
  }));
  const patch = vi.fn<CalendarApi['events']['patch']>(async () => ({
    data: { ...eventFixture, etag: '"etag-2"', sequence: 1 },
  }));
  const del = vi.fn<CalendarApi['events']['delete']>(async () => ({}));
  const list = vi.fn<CalendarApi['events']['list']>(async () => ({
    data: {
      items: [eventFixture, { id: 'evt-gone', status: 'cancelled' }],
      nextSyncToken: 'sync-2',
    },
  }));
  const watch = vi.fn<CalendarApi['events']['watch']>(async () => ({
    data: { id: 'chan-1', resourceId: 'res-1', expiration: '1800000000000' },
  }));
  const query = vi.fn<CalendarApi['freebusy']['query']>(async () => ({
    data: {
      calendars: {
        primary: { busy: [{ start: '2026-11-02T10:00:00Z', end: '2026-11-02T10:30:00Z' }] },
        'team@example.com': { errors: [{ domain: 'global', reason: 'notFound' }], busy: [] },
      },
    },
  }));
  const calendarList = vi.fn<CalendarApi['calendarList']['list']>(async () => ({
    data: {
      items: [
        {
          id: 'primary',
          summary: 'Organiser',
          primary: true,
          accessRole: 'owner',
          timeZone: 'Africa/Lagos',
        },
      ],
    },
  }));
  const stop = vi.fn<CalendarApi['channels']['stop']>(async () => ({}));
  const api: CalendarApi = {
    events: { insert, get, patch, delete: del, list, watch },
    freebusy: { query },
    calendarList: { list: calendarList },
    channels: { stop },
  };
  return { api, insert, get, patch, del, list, watch, query, calendarList, stop };
}

const credentials: CalendarCredentials = {
  accessToken: 'ya29.stored',
  refreshToken: '1//refresh-stored',
  expiresAt: new Date(1_800_000_000_000),
  scope: ['openid', 'email'],
  idTokenEmail: 'organiser@example.com',
};

function provider(oauth: OAuthStub, api: CalendarApi) {
  return new GoogleCalendarProvider({
    clientId: 'client-id',
    clientSecret: 'GOCSPX-secret',
    redirectUri: 'https://app.example.com/api/v1/admin/integrations/google/callback',
    oauthClientFactory: () => oauth,
    calendarClientFactory: () => api,
    now: () => new Date(1_700_000_000_000),
  });
}

describe('GoogleCalendarProvider OAuth', () => {
  it('builds an offline, consent-forcing, PKCE authorisation URL', () => {
    const oauth = oauthStub();
    const url = new URL(
      provider(oauth, calendarStub().api).buildAuthorizationUrl({
        redirectUri: 'https://app.example.com/api/v1/admin/integrations/google/callback',
        state: 'nonce.123.sig',
        codeChallenge: 'challenge',
        scopes: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events.owned'],
        loginHint: 'organiser@example.com',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    expect(url.searchParams.get('code_challenge')).toBe('challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('nonce.123.sig');
    expect(url.searchParams.get('login_hint')).toBe('organiser@example.com');
    expect(url.searchParams.get('scope')).toContain('calendar.events.owned');
  });

  it('exchanges the code with the PKCE verifier and reads the ID token email', async () => {
    const oauth = oauthStub();
    const tokens = await provider(oauth, calendarStub().api).exchangeCode({
      code: '4/code',
      codeVerifier: 'verifier',
      redirectUri: 'https://app.example.com/cb',
    });
    expect(oauth.getToken).toHaveBeenCalledWith({
      code: '4/code',
      codeVerifier: 'verifier',
      redirect_uri: 'https://app.example.com/cb',
    });
    expect(tokens).toEqual({
      accessToken: 'ya29.first',
      refreshToken: '1//refresh-first',
      expiresAt: new Date(1_800_000_000_000),
      scope: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events.owned'],
      idTokenEmail: 'organiser@example.com',
    });
    expect(emailFromIdToken('garbage')).toBeNull();
  });

  it('maps invalid_grant on refresh to CalendarAuthError with reconnect instructions', async () => {
    const oauth = oauthStub();
    oauth.refreshAccessToken.mockRejectedValueOnce(
      gaxiosError(
        400,
        { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
        'invalid_grant',
      ),
    );
    const p = provider(oauth, calendarStub().api);
    const err = await p.refresh(credentials).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CalendarAuthError);
    expect((err as CalendarAuthError).reconnectRequired).toBe(true);
    expect((err as CalendarAuthError).instructions).toMatch(/reconnect/i);
    expect((err as CalendarAuthError).providerReason).toBe('invalid_grant');

    const refreshed = await p.refresh(credentials);
    expect(refreshed.accessToken).toBe('ya29.refreshed');
    expect(refreshed.refreshToken).toBe('1//refresh-stored'); // preserved when Google omits it
    await expect(p.refresh({ ...credentials, refreshToken: null })).rejects.toBeInstanceOf(
      CalendarAuthError,
    );
  });

  it('treats an already-revoked token as revoked', async () => {
    const oauth = oauthStub();
    oauth.revokeToken.mockRejectedValueOnce(gaxiosError(400, { error: 'invalid_token' }));
    await expect(provider(oauth, calendarStub().api).revoke('1//gone')).resolves.toBeUndefined();
    oauth.revokeToken.mockRejectedValueOnce(gaxiosError(503));
    await expect(provider(oauth, calendarStub().api).revoke('1//x')).rejects.toBeInstanceOf(
      CalendarProviderError,
    );
  });
});

describe('GoogleCalendarProvider events', () => {
  it('creates events with conferenceDataVersion=1, hangoutsMeet, the request id and our private props', async () => {
    const oauth = oauthStub();
    const cal = calendarStub();
    const result = await provider(oauth, cal.api).createEvent(credentials, {
      calendarId: 'primary',
      appointmentId: 'appt-1',
      conferenceRequestId: 'req-1',
      summary: 'Consultation',
      description: 'Notes',
      start: '2026-11-02T08:00:00Z',
      end: '2026-11-02T08:30:00Z',
      timeZone: 'Africa/Lagos',
      attendees: [{ email: 'customer@example.com', displayName: 'Customer' }],
      sendUpdates: 'all',
      privateProps: { simplexdKind: 'consultation' },
      reminders: [{ method: 'email', minutes: 1440 }],
    });
    expect(oauth.credentials).toMatchObject({
      access_token: 'ya29.stored',
      refresh_token: '1//refresh-stored',
    });
    const [params, options] = cal.insert.mock.calls[0]!;
    expect(params.calendarId).toBe('primary');
    expect(params.conferenceDataVersion).toBe(1);
    expect(params.sendUpdates).toBe('all');
    expect(params.requestBody?.conferenceData).toEqual({
      createRequest: { requestId: 'req-1', conferenceSolutionKey: { type: 'hangoutsMeet' } },
    });
    expect(params.requestBody?.id).toBe(deterministicEventId('appt-1', 'req-1'));
    expect(params.requestBody?.start).toEqual({
      dateTime: '2026-11-02T08:00:00.000Z',
      timeZone: 'Africa/Lagos',
    });
    expect(params.requestBody?.attendees).toEqual([
      {
        email: 'customer@example.com',
        displayName: 'Customer',
        optional: false,
        responseStatus: 'needsAction',
      },
    ]);
    expect(params.requestBody?.extendedProperties?.private).toMatchObject({
      simplexdAppointmentId: 'appt-1',
      simplexdConferenceRequestId: 'req-1',
      simplexdKind: 'consultation',
    });
    expect(params.requestBody?.reminders).toEqual({
      useDefault: false,
      overrides: [{ method: 'email', minutes: 1440 }],
    });
    expect(options?.timeout).toBe(15_000);
    expect(result.conference).toEqual({ status: 'pending', meetUrl: null, requestId: 'req-1' });
    expect(result.eventId).toBe('evt-1');
  });

  it('returns the existing event when a retried insert hits 409', async () => {
    const oauth = oauthStub();
    const cal = calendarStub();
    cal.insert.mockRejectedValueOnce(
      gaxiosError(409, { error: { errors: [{ reason: 'duplicate' }] } }),
    );
    const result = await provider(oauth, cal.api).createEvent(credentials, {
      calendarId: 'primary',
      appointmentId: 'appt-1',
      conferenceRequestId: 'req-1',
      summary: 'Consultation',
      start: '2026-11-02T08:00:00Z',
      end: '2026-11-02T08:30:00Z',
      timeZone: 'Africa/Lagos',
      attendees: [],
      sendUpdates: 'none',
    });
    expect(cal.get).toHaveBeenCalledWith(
      { calendarId: 'primary', eventId: deterministicEventId('appt-1', 'req-1') },
      expect.anything(),
    );
    expect(result.conference).toEqual({
      status: 'ready',
      meetUrl: 'https://meet.google.com/abc-defg-hij',
      requestId: 'req-1',
    });
  });

  it('polls conference status through getEvent', async () => {
    const cal = calendarStub();
    const result = await provider(oauthStub(), cal.api).getEvent(credentials, {
      calendarId: 'primary',
      eventId: 'evt-1',
    });
    expect(result.conference.status).toBe('ready');
    expect(result.conference.meetUrl).toBe('https://meet.google.com/abc-defg-hij');
    expect(
      parseConference({
        conferenceData: { createRequest: { requestId: 'r', status: { statusCode: 'failure' } } },
      }),
    ).toEqual({
      status: 'failed',
      meetUrl: null,
      requestId: 'r',
    });
    expect(parseConference({})).toEqual({ status: 'none', meetUrl: null, requestId: null });
  });

  it('sends If-Match on update and maps 412 to CalendarConflictError', async () => {
    const cal = calendarStub();
    const p = provider(oauthStub(), cal.api);
    const updated = await p.updateEvent(credentials, {
      calendarId: 'primary',
      eventId: 'evt-1',
      etag: '"etag-1"',
      patch: {
        start: '2026-11-02T09:00:00Z',
        end: '2026-11-02T09:30:00Z',
        timeZone: 'Africa/Lagos',
        conferenceRequestId: 'req-2',
      },
      sendUpdates: 'all',
    });
    const [params, options] = cal.patch.mock.calls[0]!;
    expect(options?.headers).toEqual({ 'If-Match': '"etag-1"' });
    expect(params.conferenceDataVersion).toBe(1);
    expect(params.requestBody?.start).toEqual({
      dateTime: '2026-11-02T09:00:00.000Z',
      timeZone: 'Africa/Lagos',
    });
    expect(params.requestBody?.conferenceData?.createRequest?.requestId).toBe('req-2');
    expect(updated.etag).toBe('"etag-2"');

    cal.patch.mockRejectedValueOnce(
      gaxiosError(412, { error: { errors: [{ reason: 'conditionNotMet' }] } }),
    );
    await expect(
      p.updateEvent(credentials, {
        calendarId: 'primary',
        eventId: 'evt-1',
        etag: '"stale"',
        patch: { summary: 'x' },
        sendUpdates: 'none',
      }),
    ).rejects.toBeInstanceOf(CalendarConflictError);
  });

  it('cancels with If-Match and treats 404/410 as already gone', async () => {
    const cal = calendarStub();
    const p = provider(oauthStub(), cal.api);
    expect(
      await p.cancelEvent(credentials, {
        calendarId: 'primary',
        eventId: 'evt-1',
        etag: '"etag-1"',
        sendUpdates: 'all',
      }),
    ).toEqual({
      status: 'cancelled',
    });
    const [params, options] = cal.del.mock.calls[0]!;
    expect(params).toEqual({ calendarId: 'primary', eventId: 'evt-1', sendUpdates: 'all' });
    expect(options?.headers).toEqual({ 'If-Match': '"etag-1"' });
    cal.del.mockRejectedValueOnce(gaxiosError(410));
    expect(
      await p.cancelEvent(credentials, {
        calendarId: 'primary',
        eventId: 'evt-1',
        etag: null,
        sendUpdates: 'all',
      }),
    ).toEqual({
      status: 'already_gone',
    });
  });

  it('reads free/busy without event details and reports per-calendar errors', async () => {
    const cal = calendarStub();
    const result = await provider(oauthStub(), cal.api).freeBusy(credentials, {
      calendarIds: ['primary', 'team@example.com'],
      timeMin: '2026-11-02T00:00:00Z',
      timeMax: '2026-11-03T00:00:00Z',
      timeZone: 'Africa/Lagos',
    });
    expect(cal.query.mock.calls[0]![0].requestBody).toEqual({
      timeMin: '2026-11-02T00:00:00.000Z',
      timeMax: '2026-11-03T00:00:00.000Z',
      timeZone: 'Africa/Lagos',
      items: [{ id: 'primary' }, { id: 'team@example.com' }],
    });
    expect(result.busy).toEqual([
      { calendarId: 'primary', start: '2026-11-02T10:00:00Z', end: '2026-11-02T10:30:00Z' },
    ]);
    expect(result.errors).toEqual([{ calendarId: 'team@example.com', reason: 'notFound' }]);
  });

  it('watches with a web_hook channel and stops it', async () => {
    const cal = calendarStub();
    const p = provider(oauthStub(), cal.api);
    const watch = await p.watchEvents(credentials, {
      calendarId: 'primary',
      channelId: 'chan-1',
      address: 'https://app.example.com/api/v1/webhooks/google-calendar',
      token: 'tok',
      ttlSeconds: 604_800,
    });
    expect(cal.watch.mock.calls[0]![0].requestBody).toEqual({
      id: 'chan-1',
      type: 'web_hook',
      address: 'https://app.example.com/api/v1/webhooks/google-calendar',
      token: 'tok',
      expiration: String(1_700_000_000_000 + 604_800_000),
    });
    expect(watch).toEqual({
      channelId: 'chan-1',
      resourceId: 'res-1',
      expiration: new Date(1_800_000_000_000),
    });
    await expect(
      p.watchEvents(credentials, {
        calendarId: 'primary',
        channelId: 'c',
        address: 'http://insecure',
        token: 't',
        ttlSeconds: 60,
      }),
    ).rejects.toThrow(/HTTPS/);
    await p.stopChannel(credentials, { channelId: 'chan-1', resourceId: 'res-1' });
    expect(cal.stop.mock.calls[0]![0].requestBody).toEqual({ id: 'chan-1', resourceId: 'res-1' });
  });

  it('lists changes incrementally with showDeleted and maps 410 to a full resync', async () => {
    const cal = calendarStub();
    const p = provider(oauthStub(), cal.api);
    const changes = await p.listChanges(credentials, {
      calendarId: 'primary',
      syncToken: 'sync-1',
      timeMin: '2026-01-01T00:00:00Z',
    });
    const params = cal.list.mock.calls[0]![0];
    expect(params).toMatchObject({
      calendarId: 'primary',
      syncToken: 'sync-1',
      showDeleted: true,
      singleEvents: true,
    });
    expect(params.timeMin).toBeUndefined(); // forbidden together with syncToken
    expect(changes.items.map((i) => [i.id, i.status])).toEqual([
      ['evt-1', 'confirmed'],
      ['evt-gone', 'cancelled'],
    ]);
    expect(changes.nextSyncToken).toBe('sync-2');
    expect(changes.fullResyncRequired).toBe(false);

    cal.list.mockRejectedValueOnce(
      gaxiosError(410, { error: { errors: [{ reason: 'fullSyncRequired' }] } }),
    );
    const gone = await p.listChanges(credentials, { calendarId: 'primary', syncToken: 'sync-2' });
    expect(gone).toEqual({
      items: [],
      nextPageToken: null,
      nextSyncToken: null,
      fullResyncRequired: true,
    });

    await p.listChanges(credentials, { calendarId: 'primary', timeMin: '2026-01-01T00:00:00Z' });
    expect(cal.list.mock.calls[2]![0].timeMin).toBe('2026-01-01T00:00:00.000Z');
  });

  it('hands rotated tokens to onRotated, preserving the stored refresh token', async () => {
    const oauth = oauthStub();
    const cal = calendarStub();
    cal.calendarList.mockImplementationOnce(async () => {
      oauth.emitTokens({ access_token: 'ya29.rotated', expiry_date: 1_800_009_000_000 });
      return {
        data: {
          items: [{ id: 'primary', summary: 'Organiser', primary: true, accessRole: 'owner' }],
        },
      };
    });
    const onRotated = vi.fn();
    const calendars = await provider(oauth, cal.api).listCalendars({ ...credentials, onRotated });
    expect(calendars).toEqual([
      { id: 'primary', summary: 'Organiser', primary: true, accessRole: 'owner', timeZone: null },
    ]);
    expect(onRotated).toHaveBeenCalledWith({
      accessToken: 'ya29.rotated',
      refreshToken: '1//refresh-stored',
      expiresAt: new Date(1_800_009_000_000),
      scope: ['openid', 'email'],
      idTokenEmail: 'organiser@example.com',
    });
  });

  it('reports connection health with sanitised messages', async () => {
    const cal = calendarStub();
    const p = provider(oauthStub(), cal.api);
    expect(await p.testConnection(credentials)).toMatchObject({
      ok: true,
      calendarCount: 1,
      accountEmail: 'organiser@example.com',
    });
    cal.calendarList.mockRejectedValueOnce(
      gaxiosError(401, { error: 'invalid_grant' }, 'invalid_grant ya29.leaked-token Bearer abc'),
    );
    const failed = await p.testConnection(credentials);
    expect(failed.ok).toBe(false);
    expect(failed.reconnectRequired).toBe(true);
    expect(failed.message).not.toContain('ya29.leaked-token');
    expect(failed.message).not.toContain('Bearer abc');
  });
});

describe('mapGoogleError and factory', () => {
  it('classifies provider errors', () => {
    expect(
      mapGoogleError(
        gaxiosError(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } }),
      ),
    ).toMatchObject({
      code: 'rate_limited',
      retryable: true,
    });
    expect(
      mapGoogleError(
        gaxiosError(403, { error: { errors: [{ reason: 'insufficientPermissions' }] } }),
      ),
    ).toBeInstanceOf(CalendarAuthError);
    expect(mapGoogleError(gaxiosError(404))).toMatchObject({ code: 'not_found' });
    expect(mapGoogleError(gaxiosError(503))).toMatchObject({ retryable: true, httpStatus: 503 });
    expect(
      mapGoogleError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })),
    ).toMatchObject({
      code: 'network',
      retryable: true,
    });
    expect(mapGoogleError('weird').message).toBe('Google Calendar request failed');
  });

  it('selects adapters by configuration and refuses dev outside development/test', () => {
    expect(
      createCalendarProvider({
        appEnv: 'production',
        clientId: 'id',
        clientSecret: 'secret',
        redirectUri: 'https://app.example.com/cb',
      }).id,
    ).toBe('google');
    expect(
      createCalendarProvider({ appEnv: 'test', redirectUri: 'http://localhost:3000/cb' }).id,
    ).toBe('dev');
    expect(() =>
      createCalendarProvider({ appEnv: 'production', redirectUri: 'https://app.example.com/cb' }),
    ).toThrow(/not configured/);
    expect(() =>
      createCalendarProvider({
        appEnv: 'production',
        adapter: 'google',
        redirectUri: 'https://app.example.com/cb',
      }),
    ).toThrow(/client ID and secret/);
  });
});
