import { createHash } from 'node:crypto';
import {
  auth as googleAuth,
  calendar as createCalendarClient,
} from 'googleapis/build/src/apis/calendar/index.js';
import type { calendar_v3 } from 'googleapis/build/src/apis/calendar/index.js';
import {
  CalendarAuthError,
  CalendarConflictError,
  CalendarNotConfiguredError,
  CalendarProviderError,
  sanitizeErrorMessage,
} from './errors';
import {
  PRIVATE_PROPERTY_KEYS,
  type AuthorizationUrlInput,
  type CalendarCredentials,
  type CalendarProvider,
  type CalendarSummary,
  type CancelEventInput,
  type CancelEventResult,
  type ChangedEvent,
  type ConferenceInfo,
  type ConnectionTestResult,
  type CreateEventInput,
  type EventPatch,
  type EventResult,
  type EventStatus,
  type ExchangeCodeInput,
  type FreeBusyInput,
  type FreeBusyResult,
  type ListChangesInput,
  type ListChangesResult,
  type SendUpdates,
  type StopChannelInput,
  type TokenSet,
  type UpdateEventInput,
  type WatchEventsInput,
  type WatchResult,
} from './types';

/**
 * Google Calendar + Meet adapter on the official `googleapis` client.
 *
 * Only the calendar sub-module is imported (`googleapis/build/src/apis/calendar`)
 * so the process does not load the other 200+ generated APIs. It is the same
 * code `@googleapis/calendar` publishes.
 *
 * One OAuth2 client is created per call (credentials are instance state), the
 * stored tokens are attached with setCredentials, and the `tokens` event is
 * captured so rotated access/refresh tokens reach `credentials.onRotated`.
 */

/** Subset of google-auth-library `Credentials` we read and write. */
export interface OAuthCredentials {
  access_token?: string | null;
  refresh_token?: string | null;
  expiry_date?: number | null;
  scope?: string;
  id_token?: string | null;
  token_type?: string | null;
}

export interface GenerateAuthUrlOptions {
  access_type?: string;
  prompt?: string;
  include_granted_scopes?: boolean;
  scope?: string | string[];
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  login_hint?: string;
  redirect_uri?: string;
  /** The library's options carry a query-string index signature; keep the real client assignable. */
  [key: string]: unknown;
}

/** Structural view of `google.auth.OAuth2` so tests can inject a stub. */
export interface OAuthClientLike {
  credentials: OAuthCredentials;
  generateAuthUrl(opts?: GenerateAuthUrlOptions): string;
  getToken(options: {
    code: string;
    codeVerifier?: string;
    redirect_uri?: string;
  }): Promise<{ tokens: OAuthCredentials }>;
  setCredentials(credentials: OAuthCredentials): void;
  refreshAccessToken(): Promise<{ credentials: OAuthCredentials }>;
  revokeToken(token: string): Promise<unknown>;
  on(event: 'tokens', listener: (tokens: OAuthCredentials) => void): unknown;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  timeout?: number;
}

/** Structural view of `calendar_v3.Calendar` limited to what the adapter uses. */
export interface CalendarApi {
  calendarList: {
    list(
      params: calendar_v3.Params$Resource$Calendarlist$List,
      options?: RequestOptions,
    ): Promise<{ data: calendar_v3.Schema$CalendarList }>;
  };
  freebusy: {
    query(
      params: calendar_v3.Params$Resource$Freebusy$Query,
      options?: RequestOptions,
    ): Promise<{ data: calendar_v3.Schema$FreeBusyResponse }>;
  };
  events: {
    insert(
      params: calendar_v3.Params$Resource$Events$Insert,
      options?: RequestOptions,
    ): Promise<{ data: calendar_v3.Schema$Event }>;
    get(
      params: calendar_v3.Params$Resource$Events$Get,
      options?: RequestOptions,
    ): Promise<{ data: calendar_v3.Schema$Event }>;
    patch(
      params: calendar_v3.Params$Resource$Events$Patch,
      options?: RequestOptions,
    ): Promise<{ data: calendar_v3.Schema$Event }>;
    delete(params: calendar_v3.Params$Resource$Events$Delete, options?: RequestOptions): Promise<unknown>;
    list(
      params: calendar_v3.Params$Resource$Events$List,
      options?: RequestOptions,
    ): Promise<{ data: calendar_v3.Schema$Events }>;
    watch(
      params: calendar_v3.Params$Resource$Events$Watch,
      options?: RequestOptions,
    ): Promise<{ data: calendar_v3.Schema$Channel }>;
  };
  channels: {
    stop(params: calendar_v3.Params$Resource$Channels$Stop, options?: RequestOptions): Promise<unknown>;
  };
}

export interface GoogleCalendarProviderOptions {
  clientId: string;
  clientSecret: string;
  /** `${APP_URL}/api/v1/admin/integrations/google/callback`; must match the Cloud Console entry exactly. */
  redirectUri: string;
  /** Test seam: build the calendar client from the per-call OAuth client. */
  calendarClientFactory?: (auth: OAuthClientLike) => CalendarApi;
  /** Test seam: build the per-call OAuth client. */
  oauthClientFactory?: (config: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }) => OAuthClientLike;
  requestTimeoutMs?: number;
  now?: () => Date;
}

type OAuth2Client = InstanceType<typeof googleAuth.OAuth2>;

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_CALENDAR_PAGES = 10;
const MEET_SOLUTION_TYPE = 'hangoutsMeet';

interface ErrorShape {
  message?: unknown;
  status?: unknown;
  code?: unknown;
  response?: { status?: unknown; data?: unknown };
}

function asErrorShape(err: unknown): ErrorShape {
  return typeof err === 'object' && err !== null ? (err as ErrorShape) : {};
}

/** HTTP status of a gaxios error, wherever it lives. */
export function extractHttpStatus(err: unknown): number | null {
  const e = asErrorShape(err);
  const candidates = [e.response?.status, e.status, e.code];
  for (const c of candidates) if (typeof c === 'number' && c >= 100 && c <= 599) return c;
  return null;
}

/** Sanitised error mapping; never throws raw gaxios errors (they embed request config). */
export function mapGoogleError(err: unknown): CalendarProviderError {
  if (err instanceof CalendarProviderError) return err;
  const e = asErrorShape(err);
  const message = typeof e.message === 'string' ? e.message : 'Google Calendar request failed';
  const status = extractHttpStatus(err);
  const data = (e.response?.data ?? null) as
    | { error?: unknown; error_description?: unknown }
    | string
    | null;
  const body = typeof data === 'object' && data !== null ? data : null;
  const oauthError = typeof body?.error === 'string' ? body.error : null;
  const description = typeof body?.error_description === 'string' ? body.error_description : '';
  const apiError =
    typeof body?.error === 'object' && body.error !== null
      ? (body.error as { errors?: Array<{ reason?: string }>; status?: string; message?: string })
      : null;
  const reason = apiError?.errors?.[0]?.reason ?? apiError?.status ?? null;

  if (oauthError === 'invalid_grant' || /invalid_grant/i.test(message)) {
    return new CalendarAuthError(`Google rejected the stored grant (invalid_grant) ${description}`, {
      httpStatus: status,
      providerReason: 'invalid_grant',
    });
  }
  if (oauthError === 'invalid_client' || oauthError === 'unauthorized_client') {
    return new CalendarAuthError(
      `Google rejected the OAuth client (${oauthError}); check the client ID, secret and redirect URI`,
      { httpStatus: status, providerReason: oauthError, reconnectRequired: false },
    );
  }
  if (status === 401) {
    return new CalendarAuthError('Google rejected the access token (401)', {
      httpStatus: 401,
      providerReason: reason,
    });
  }
  if (status === 412) return new CalendarConflictError();
  if (status === 403) {
    if (reason && /rateLimit|quota|userRateLimit/i.test(reason)) {
      return new CalendarProviderError(`Google Calendar quota exceeded (${reason})`, {
        code: 'rate_limited',
        httpStatus: 403,
        retryable: true,
        providerReason: reason,
      });
    }
    if (reason && /insufficientPermissions|forbidden|accessNotConfigured/i.test(reason)) {
      return new CalendarAuthError(`Google denied the request (${reason}): ${message}`, {
        httpStatus: 403,
        providerReason: reason,
        instructions:
          'The connected account lacks the required Calendar scopes or the Calendar API is not enabled for the Cloud project. Enable the API and reconnect the organiser, accepting every requested scope.',
      });
    }
    return new CalendarProviderError(message, { httpStatus: 403, providerReason: reason });
  }
  if (status === 404)
    return new CalendarProviderError(`Google Calendar resource not found: ${message}`, {
      code: 'not_found',
      httpStatus: 404,
      providerReason: reason,
    });
  if (status === 409)
    return new CalendarProviderError(`Google Calendar resource already exists: ${message}`, {
      code: 'already_exists',
      httpStatus: 409,
      providerReason: reason,
    });
  if (status === 429)
    return new CalendarProviderError(`Google Calendar rate limit: ${message}`, {
      code: 'rate_limited',
      httpStatus: 429,
      retryable: true,
      providerReason: reason,
    });
  if (status === 400)
    return new CalendarProviderError(`Google rejected the request: ${message}`, {
      code: 'invalid_request',
      httpStatus: 400,
      providerReason: reason,
    });
  if (status !== null && status >= 500)
    return new CalendarProviderError(`Google Calendar is unavailable (${status})`, {
      httpStatus: status,
      retryable: true,
      providerReason: reason,
    });
  const code = typeof e.code === 'string' ? e.code : '';
  if (/ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|TimeoutError|AbortError/i.test(code)) {
    return new CalendarProviderError(`network error talking to Google (${code})`, {
      code: 'network',
      retryable: true,
    });
  }
  return new CalendarProviderError(message, { httpStatus: status, providerReason: reason });
}

/**
 * Reads the `email` claim of the ID token returned by Google's token endpoint.
 * The token arrived directly from Google over TLS, so the signature is not
 * re-verified here; this is display/identification data, not authentication.
 */
export function emailFromIdToken(idToken: string | null | undefined): string | null {
  if (!idToken) return null;
  const parts = idToken.split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      email?: unknown;
      email_verified?: unknown;
    };
    if (typeof payload.email !== 'string') return null;
    return payload.email_verified === false ? null : payload.email;
  } catch {
    return null;
  }
}

export function toTokenSet(credentials: OAuthCredentials, previous?: TokenSet | null): TokenSet {
  const accessToken = credentials.access_token ?? previous?.accessToken ?? null;
  if (!accessToken) {
    throw new CalendarAuthError('Google did not return an access token', {
      reconnectRequired: true,
    });
  }
  return {
    accessToken,
    refreshToken: credentials.refresh_token ?? previous?.refreshToken ?? null,
    expiresAt:
      typeof credentials.expiry_date === 'number'
        ? new Date(credentials.expiry_date)
        : (previous?.expiresAt ?? null),
    scope: credentials.scope
      ? credentials.scope.split(/\s+/).filter(Boolean)
      : (previous?.scope ?? []),
    idTokenEmail: emailFromIdToken(credentials.id_token) ?? previous?.idTokenEmail ?? null,
  };
}

/**
 * Deterministic event id (Google accepts client ids in base32hex, 5–1024
 * chars; hex digits are a subset). A retried insert for the same appointment
 * and conference request therefore hits 409 instead of creating a duplicate.
 */
export function deterministicEventId(appointmentId: string, conferenceRequestId: string): string {
  return createHash('sha256').update(`${appointmentId}:${conferenceRequestId}`).digest('hex');
}

function toRfc3339(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new CalendarProviderError(`invalid date/time: ${value}`, {
    code: 'invalid_request',
  });
  return d.toISOString();
}

function eventStatus(value: string | null | undefined): EventStatus {
  return value === 'cancelled' || value === 'tentative' ? value : 'confirmed';
}

export function parseConference(event: calendar_v3.Schema$Event): ConferenceInfo {
  const cd = event.conferenceData;
  if (!cd) return { status: 'none', meetUrl: null, requestId: null };
  const requestId = cd.createRequest?.requestId ?? null;
  const statusCode = cd.createRequest?.status?.statusCode ?? null;
  const video = cd.entryPoints?.find((p) => p.entryPointType === 'video')?.uri ?? null;
  const meetUrl = video ?? event.hangoutLink ?? null;
  if (statusCode === 'failure') return { status: 'failed', meetUrl: null, requestId };
  if (meetUrl) return { status: 'ready', meetUrl, requestId };
  if (statusCode === 'pending' || (statusCode === null && requestId))
    return { status: 'pending', meetUrl: null, requestId };
  // "success" without a video entry point cannot be joined: report it so the app retries with a new request id.
  if (statusCode === 'success') return { status: 'failed', meetUrl: null, requestId };
  return { status: 'none', meetUrl: null, requestId };
}

export function toEventResult(event: calendar_v3.Schema$Event): EventResult {
  if (!event.id) throw new CalendarProviderError('Google returned an event without an id');
  return {
    eventId: event.id,
    etag: event.etag ?? '',
    sequence: event.sequence ?? 0,
    htmlLink: event.htmlLink ?? null,
    status: eventStatus(event.status),
    start: event.start?.dateTime ?? event.start?.date ?? null,
    end: event.end?.dateTime ?? event.end?.date ?? null,
    updated: event.updated ?? null,
    conference: parseConference(event),
    extendedPrivate: { ...(event.extendedProperties?.private ?? {}) },
  };
}

function toChangedEvent(event: calendar_v3.Schema$Event): ChangedEvent | null {
  if (!event.id) return null;
  return {
    id: event.id,
    status: eventStatus(event.status),
    start: event.start?.dateTime ?? event.start?.date ?? null,
    end: event.end?.dateTime ?? event.end?.date ?? null,
    etag: event.etag ?? null,
    sequence: typeof event.sequence === 'number' ? event.sequence : null,
    updated: event.updated ?? null,
    extendedPrivate: { ...(event.extendedProperties?.private ?? {}) },
  };
}

function attendeesBody(
  attendees: CreateEventInput['attendees'],
): calendar_v3.Schema$EventAttendee[] {
  return attendees.map((a) => ({
    email: a.email,
    displayName: a.displayName,
    optional: a.optional ?? false,
    responseStatus: 'needsAction',
  }));
}

function remindersBody(
  reminders: CreateEventInput['reminders'],
): calendar_v3.Schema$Event['reminders'] {
  if (!reminders) return { useDefault: true };
  if (reminders.length > 5) throw new CalendarProviderError('at most 5 reminder overrides', {
    code: 'invalid_request',
  });
  return { useDefault: false, overrides: reminders.map((r) => ({ method: r.method, minutes: r.minutes })) };
}

function conferenceCreateRequest(requestId: string): calendar_v3.Schema$ConferenceData {
  return { createRequest: { requestId, conferenceSolutionKey: { type: MEET_SOLUTION_TYPE } } };
}

function patchBody(patch: EventPatch, appointmentId: string | null): calendar_v3.Schema$Event {
  const body: calendar_v3.Schema$Event = {};
  if (patch.summary !== undefined) body.summary = patch.summary;
  if (patch.description !== undefined) body.description = patch.description;
  if (patch.location !== undefined) body.location = patch.location;
  if (patch.start !== undefined)
    body.start = { dateTime: toRfc3339(patch.start), timeZone: patch.timeZone };
  if (patch.end !== undefined) body.end = { dateTime: toRfc3339(patch.end), timeZone: patch.timeZone };
  if (patch.attendees !== undefined) body.attendees = attendeesBody(patch.attendees);
  if (patch.reminders !== undefined) body.reminders = remindersBody(patch.reminders);
  if (patch.privateProps !== undefined) {
    body.extendedProperties = {
      private: {
        ...patch.privateProps,
        ...(appointmentId ? { [PRIVATE_PROPERTY_KEYS.appointmentId]: appointmentId } : {}),
      },
    };
  }
  if (patch.conferenceRequestId !== undefined) {
    body.conferenceData = conferenceCreateRequest(patch.conferenceRequestId);
    body.extendedProperties = {
      private: {
        ...(body.extendedProperties?.private ?? {}),
        [PRIVATE_PROPERTY_KEYS.conferenceRequestId]: patch.conferenceRequestId,
      },
    };
  }
  return body;
}

export class GoogleCalendarProvider implements CalendarProvider {
  readonly id = 'google' as const;
  private readonly options: GoogleCalendarProviderOptions;
  private readonly timeoutMs: number;

  constructor(options: GoogleCalendarProviderOptions) {
    if (!options.clientId || !options.clientSecret) {
      throw new CalendarNotConfiguredError(
        'Google Workspace is not configured: client ID and client secret are required',
      );
    }
    if (!/^https?:\/\//.test(options.redirectUri)) {
      throw new CalendarNotConfiguredError('Google redirect URI must be an absolute http(s) URL');
    }
    this.options = options;
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private newOAuthClient(): OAuthClientLike {
    const config = {
      clientId: this.options.clientId,
      clientSecret: this.options.clientSecret,
      redirectUri: this.options.redirectUri,
    };
    if (this.options.oauthClientFactory) return this.options.oauthClientFactory(config);
    return new googleAuth.OAuth2(config.clientId, config.clientSecret, config.redirectUri);
  }

  private calendarFor(oauth: OAuthClientLike): CalendarApi {
    if (this.options.calendarClientFactory) return this.options.calendarClientFactory(oauth);
    // Default pairing: the default OAuth factory returns a real OAuth2Client.
    return createCalendarClient({ version: 'v3', auth: oauth as OAuth2Client });
  }

  private requestOptions(extraHeaders?: Record<string, string>): RequestOptions {
    return extraHeaders ? { timeout: this.timeoutMs, headers: extraHeaders } : { timeout: this.timeoutMs };
  }

  /**
   * Runs `fn` with a per-call authenticated client. Rotated tokens (lazy refresh
   * by the library) are handed to `credentials.onRotated` even when the call
   * itself fails, so the newest refresh token is never lost.
   */
  private async withClient<T>(
    credentials: CalendarCredentials,
    fn: (api: CalendarApi, oauth: OAuthClientLike) => Promise<T>,
  ): Promise<T> {
    const oauth = this.newOAuthClient();
    oauth.setCredentials({
      access_token: credentials.accessToken,
      refresh_token: credentials.refreshToken ?? undefined,
      expiry_date: credentials.expiresAt ? credentials.expiresAt.getTime() : undefined,
      scope: credentials.scope.length > 0 ? credentials.scope.join(' ') : undefined,
    });
    let rotated: OAuthCredentials | null = null;
    oauth.on('tokens', (tokens) => {
      rotated = { ...(rotated ?? {}), ...tokens };
    });
    const api = this.calendarFor(oauth);
    try {
      const result = await fn(api, oauth);
      await this.emitRotated(credentials, rotated);
      return result;
    } catch (err) {
      await this.emitRotated(credentials, rotated);
      throw mapGoogleError(err);
    }
  }

  private async emitRotated(
    credentials: CalendarCredentials,
    rotated: OAuthCredentials | null,
  ): Promise<void> {
    if (!rotated || !credentials.onRotated) return;
    if (!rotated.access_token && !rotated.refresh_token) return;
    await credentials.onRotated(toTokenSet(rotated, credentials));
  }

  buildAuthorizationUrl(input: AuthorizationUrlInput): string {
    if (input.scopes.length === 0) throw new CalendarProviderError('at least one scope is required', {
      code: 'invalid_request',
    });
    const oauth = this.newOAuthClient();
    return oauth.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      scope: [...input.scopes],
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      login_hint: input.loginHint,
      redirect_uri: input.redirectUri,
    });
  }

  async exchangeCode(input: ExchangeCodeInput): Promise<TokenSet> {
    const oauth = this.newOAuthClient();
    try {
      const { tokens } = await oauth.getToken({
        code: input.code,
        codeVerifier: input.codeVerifier,
        redirect_uri: input.redirectUri,
      });
      return toTokenSet(tokens);
    } catch (err) {
      throw mapGoogleError(err);
    }
  }

  async refresh(tokens: TokenSet): Promise<TokenSet> {
    if (!tokens.refreshToken) {
      throw new CalendarAuthError('no refresh token is stored for this connection', {
        reconnectRequired: true,
      });
    }
    const oauth = this.newOAuthClient();
    oauth.setCredentials({ refresh_token: tokens.refreshToken });
    try {
      const { credentials } = await oauth.refreshAccessToken();
      return toTokenSet(credentials, tokens);
    } catch (err) {
      throw mapGoogleError(err);
    }
  }

  async revoke(token: string): Promise<void> {
    if (!token) return;
    const oauth = this.newOAuthClient();
    try {
      await oauth.revokeToken(token);
    } catch (err) {
      // 400 = already revoked/expired: disconnecting is idempotent.
      if (extractHttpStatus(err) === 400) return;
      throw mapGoogleError(err);
    }
  }

  async listCalendars(credentials: CalendarCredentials): Promise<CalendarSummary[]> {
    return this.withClient(credentials, async (api) => {
      const out: CalendarSummary[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_CALENDAR_PAGES; page += 1) {
        const { data } = await api.calendarList.list(
          { maxResults: 250, pageToken, showDeleted: false },
          this.requestOptions(),
        );
        for (const entry of data.items ?? []) {
          if (!entry.id || entry.deleted) continue;
          out.push({
            id: entry.id,
            summary: entry.summaryOverride ?? entry.summary ?? entry.id,
            primary: entry.primary ?? false,
            accessRole: entry.accessRole ?? 'reader',
            timeZone: entry.timeZone ?? null,
          });
        }
        if (!data.nextPageToken) break;
        pageToken = data.nextPageToken;
      }
      return out;
    });
  }

  async freeBusy(credentials: CalendarCredentials, input: FreeBusyInput): Promise<FreeBusyResult> {
    if (input.calendarIds.length === 0 || input.calendarIds.length > 50) {
      throw new CalendarProviderError('freeBusy needs between 1 and 50 calendar ids', {
        code: 'invalid_request',
      });
    }
    return this.withClient(credentials, async (api) => {
      const { data } = await api.freebusy.query(
        {
          requestBody: {
            timeMin: toRfc3339(input.timeMin),
            timeMax: toRfc3339(input.timeMax),
            timeZone: input.timeZone ?? 'UTC',
            items: input.calendarIds.map((id) => ({ id })),
          },
        },
        this.requestOptions(),
      );
      const result: FreeBusyResult = { busy: [], errors: [] };
      for (const calendarId of input.calendarIds) {
        const entry = data.calendars?.[calendarId];
        if (!entry) {
          result.errors.push({ calendarId, reason: 'missing' });
          continue;
        }
        for (const err of entry.errors ?? []) {
          result.errors.push({ calendarId, reason: err.reason ?? 'unknown' });
        }
        for (const period of entry.busy ?? []) {
          if (period.start && period.end)
            result.busy.push({ calendarId, start: period.start, end: period.end });
        }
      }
      return result;
    });
  }

  async createEvent(credentials: CalendarCredentials, input: CreateEventInput): Promise<EventResult> {
    if (!input.appointmentId || !input.conferenceRequestId) {
      throw new CalendarProviderError('appointmentId and conferenceRequestId are required', {
        code: 'invalid_request',
      });
    }
    const wantConference = input.conference ?? true;
    const eventId = input.eventId ?? deterministicEventId(input.appointmentId, input.conferenceRequestId);
    const requestBody: calendar_v3.Schema$Event = {
      id: eventId,
      summary: input.summary,
      description: input.description,
      location: input.location,
      start: { dateTime: toRfc3339(input.start), timeZone: input.timeZone },
      end: { dateTime: toRfc3339(input.end), timeZone: input.timeZone },
      attendees: attendeesBody(input.attendees),
      reminders: remindersBody(input.reminders),
      guestsCanInviteOthers: false,
      extendedProperties: {
        private: {
          ...(input.privateProps ?? {}),
          [PRIVATE_PROPERTY_KEYS.appointmentId]: input.appointmentId,
          [PRIVATE_PROPERTY_KEYS.conferenceRequestId]: input.conferenceRequestId,
          [PRIVATE_PROPERTY_KEYS.source]: 'simplexd',
        },
      },
    };
    if (wantConference) requestBody.conferenceData = conferenceCreateRequest(input.conferenceRequestId);

    return this.withClient(credentials, async (api) => {
      try {
        const { data } = await api.events.insert(
          {
            calendarId: input.calendarId,
            conferenceDataVersion: 1,
            sendUpdates: input.sendUpdates,
            requestBody,
          },
          this.requestOptions(),
        );
        return toEventResult(data);
      } catch (err) {
        // Same appointment + request id retried: the event already exists, return it.
        if (extractHttpStatus(err) === 409) {
          const { data } = await api.events.get(
            { calendarId: input.calendarId, eventId },
            this.requestOptions(),
          );
          return toEventResult(data);
        }
        throw err;
      }
    });
  }

  async getEvent(
    credentials: CalendarCredentials,
    input: { calendarId: string; eventId: string },
  ): Promise<EventResult> {
    return this.withClient(credentials, async (api) => {
      const { data } = await api.events.get(
        { calendarId: input.calendarId, eventId: input.eventId },
        this.requestOptions(),
      );
      return toEventResult(data);
    });
  }

  async updateEvent(credentials: CalendarCredentials, input: UpdateEventInput): Promise<EventResult> {
    return this.withClient(credentials, async (api) => {
      const { data } = await api.events.patch(
        {
          calendarId: input.calendarId,
          eventId: input.eventId,
          conferenceDataVersion: 1,
          sendUpdates: input.sendUpdates,
          requestBody: patchBody(input.patch, null),
        },
        this.requestOptions(input.etag ? { 'If-Match': input.etag } : undefined),
      );
      return toEventResult(data);
    });
  }

  async cancelEvent(
    credentials: CalendarCredentials,
    input: CancelEventInput,
  ): Promise<CancelEventResult> {
    return this.withClient(credentials, async (api) => {
      try {
        await api.events.delete(
          { calendarId: input.calendarId, eventId: input.eventId, sendUpdates: input.sendUpdates },
          this.requestOptions(input.etag ? { 'If-Match': input.etag } : undefined),
        );
        return { status: 'cancelled' };
      } catch (err) {
        const status = extractHttpStatus(err);
        if (status === 404 || status === 410) return { status: 'already_gone' };
        throw err;
      }
    });
  }

  async watchEvents(credentials: CalendarCredentials, input: WatchEventsInput): Promise<WatchResult> {
    if (!/^https:\/\//.test(input.address)) {
      throw new CalendarProviderError('push notification address must be HTTPS on a verified domain', {
        code: 'invalid_request',
      });
    }
    const now = (this.options.now ?? (() => new Date()))();
    const expiration = now.getTime() + Math.max(60, input.ttlSeconds) * 1000;
    return this.withClient(credentials, async (api) => {
      const { data } = await api.events.watch(
        {
          calendarId: input.calendarId,
          requestBody: {
            id: input.channelId,
            type: 'web_hook',
            address: input.address,
            token: input.token,
            expiration: String(expiration),
          },
        },
        this.requestOptions(),
      );
      if (!data.resourceId) throw new CalendarProviderError('Google did not return a resourceId');
      return {
        channelId: data.id ?? input.channelId,
        resourceId: data.resourceId,
        expiration: data.expiration ? new Date(Number(data.expiration)) : null,
      };
    });
  }

  async stopChannel(credentials: CalendarCredentials, input: StopChannelInput): Promise<void> {
    await this.withClient(credentials, async (api) => {
      try {
        await api.channels.stop(
          { requestBody: { id: input.channelId, resourceId: input.resourceId } },
          this.requestOptions(),
        );
      } catch (err) {
        if (extractHttpStatus(err) === 404) return; // already stopped or expired
        throw err;
      }
    });
  }

  async listChanges(
    credentials: CalendarCredentials,
    input: ListChangesInput,
  ): Promise<ListChangesResult> {
    return this.withClient(credentials, async (api) => {
      const params: calendar_v3.Params$Resource$Events$List = {
        calendarId: input.calendarId,
        singleEvents: true,
        showDeleted: true,
        maxResults: Math.min(Math.max(input.maxResults ?? 250, 1), 2500),
        pageToken: input.pageToken ?? undefined,
      };
      if (input.syncToken) params.syncToken = input.syncToken;
      else if (input.timeMin) params.timeMin = toRfc3339(input.timeMin);
      let data: calendar_v3.Schema$Events;
      try {
        ({ data } = await api.events.list(params, this.requestOptions()));
      } catch (err) {
        if (extractHttpStatus(err) === 410) {
          return { items: [], nextPageToken: null, nextSyncToken: null, fullResyncRequired: true };
        }
        throw err;
      }
      const items: ChangedEvent[] = [];
      for (const event of data.items ?? []) {
        const changed = toChangedEvent(event);
        if (changed) items.push(changed);
      }
      return {
        items,
        nextPageToken: data.nextPageToken ?? null,
        nextSyncToken: data.nextSyncToken ?? null,
        fullResyncRequired: false,
      };
    });
  }

  async testConnection(credentials: CalendarCredentials): Promise<ConnectionTestResult> {
    const checkedAt = (this.options.now ?? (() => new Date()))();
    try {
      const calendars = await this.listCalendars(credentials);
      return {
        ok: true,
        accountEmail: credentials.idTokenEmail,
        calendarCount: calendars.length,
        checkedAt,
        message: `Connected; ${calendars.length} calendar(s) visible`,
        reconnectRequired: false,
      };
    } catch (err) {
      const mapped = mapGoogleError(err);
      return {
        ok: false,
        accountEmail: credentials.idTokenEmail,
        calendarCount: null,
        checkedAt,
        message: sanitizeErrorMessage(mapped.message),
        reconnectRequired: mapped instanceof CalendarAuthError && mapped.reconnectRequired,
      };
    }
  }
}

export type { SendUpdates };
