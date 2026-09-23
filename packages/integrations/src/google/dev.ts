import { createHash, randomBytes } from 'node:crypto';
import { CalendarAuthError, CalendarConflictError, CalendarProviderError } from './errors';
import { codeChallengeS256 } from './state';
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
  type EventResult,
  type EventStatus,
  type ExchangeCodeInput,
  type FreeBusyInput,
  type FreeBusyResult,
  type ListChangesInput,
  type ListChangesResult,
  type StopChannelInput,
  type TokenSet,
  type UpdateEventInput,
  type WatchEventsInput,
  type WatchResult,
} from './types';

/**
 * DEVELOPMENT ADAPTER — labelled, in-memory, never a production fallback.
 *
 * Simulates the Google Calendar/Meet contract closely enough to exercise the
 * booking journey without credentials: PKCE-checked code exchange, revocable
 * refresh tokens (`invalid_grant`), free/busy from stored events, event
 * creation with deterministic `https://meet.google.com/dev-xxxx` links only
 * when a conference is simulated as ready, `pending` that turns ready after N
 * polls, `failure` that succeeds on retry with a new request id, 412-style
 * conflicts on stale etags, watch channels with Google-style notification
 * headers and incremental sync tokens with an explicit "410" simulation.
 *
 * The Meet URLs do not resolve to real meetings; the UI must label them as
 * development links.
 */

export type SimulatedConference = 'ready' | 'pending' | 'failure';

export interface DevCalendarOptions {
  appEnv: string;
  simulateConference?: SimulatedConference;
  /** Number of getEvent polls before a `pending` conference becomes ready (default 1). */
  pendingPolls?: number;
  accountEmail?: string;
  calendarTimeZone?: string;
  /** Busy intervals that exist "outside" the platform (e.g. the organiser's other meetings). */
  seedBusy?: Array<{ calendarId?: string; start: string; end: string }>;
  now?: () => Date;
}

interface DevEvent {
  id: string;
  calendarId: string;
  summary: string;
  description: string | null;
  location: string | null;
  start: string;
  end: string;
  timeZone: string;
  attendees: CreateEventInput['attendees'];
  status: EventStatus;
  etagVersion: number;
  sequence: number;
  updated: string;
  extendedPrivate: Record<string, string>;
  conference: ConferenceInfo;
  pendingPollsLeft: number;
  /** Request ids that were already tried and failed (retry needs a new id). */
  failedRequestIds: Set<string>;
  changeSeq: number;
}

interface DevChannel {
  channelId: string;
  resourceId: string;
  calendarId: string;
  token: string;
  expiration: Date;
  messageNumber: number;
}

export function isDevelopmentEnvironment(appEnv: string | undefined): boolean {
  return appEnv === 'development' || appEnv === 'test';
}

export function assertDevelopmentAdapterAllowed(appEnv: string | undefined, label: string): void {
  if (!isDevelopmentEnvironment(appEnv)) {
    throw new Error(
      `${label} is a development adapter and cannot be used when APP_ENV=${appEnv ?? 'unset'}; configure the real provider`,
    );
  }
}

function etagOf(version: number): string {
  return `"dev-etag-${version}"`;
}

const SYNC_TOKEN_PREFIX = 'dev-sync-';
const PAGE_TOKEN_PREFIX = 'dev-page-';

export class DevCalendarProvider implements CalendarProvider {
  readonly id = 'dev' as const;
  private readonly options: DevCalendarOptions;
  private readonly events = new Map<string, DevEvent>();
  private readonly channels = new Map<string, DevChannel>();
  private readonly issuedRefreshTokens = new Set<string>();
  private readonly revokedTokens = new Set<string>();
  private counter = 0;
  private changeSeq = 0;
  /** Sync tokens with a sequence below this value are treated as expired (410). */
  private syncTokenFloor = 0;
  private conferenceMode: SimulatedConference;

  constructor(options: DevCalendarOptions) {
    assertDevelopmentAdapterAllowed(options.appEnv, 'DevCalendarProvider');
    this.options = options;
    this.conferenceMode = options.simulateConference ?? 'ready';
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }

  /** Change the simulated conference behaviour for subsequent bookings (admin test tool). */
  setConferenceMode(mode: SimulatedConference): void {
    this.conferenceMode = mode;
  }

  /** Simulates Google expiring every sync token issued so far (next listChanges ⇒ fullResyncRequired). */
  expireSyncTokens(): void {
    this.syncTokenFloor = this.changeSeq + 1;
  }

  /** Google-style notification headers for a channel, for exercising the webhook route. */
  simulateNotificationHeaders(
    channelId: string,
    state: 'sync' | 'exists' | 'not_exists' = 'exists',
  ): Record<string, string> {
    const channel = this.channels.get(channelId);
    if (!channel) throw new CalendarProviderError('unknown dev channel', { code: 'not_found' });
    channel.messageNumber += 1;
    return {
      'x-goog-channel-id': channel.channelId,
      'x-goog-channel-token': channel.token,
      'x-goog-resource-id': channel.resourceId,
      'x-goog-resource-state': state,
      'x-goog-message-number': String(state === 'sync' ? 1 : channel.messageNumber),
      'x-goog-channel-expiration': channel.expiration.toUTCString(),
      'x-goog-resource-uri': `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(channel.calendarId)}/events?alt=json`,
    };
  }

  private assertAccess(credentials: CalendarCredentials): void {
    if (!credentials.accessToken.startsWith('dev-access-') || this.revokedTokens.has(credentials.accessToken)) {
      if (credentials.refreshToken && this.issuedRefreshTokens.has(credentials.refreshToken)) {
        // Simulate the library's lazy refresh + `tokens` event.
        const next = this.mintTokens(credentials.refreshToken, credentials);
        void credentials.onRotated?.(next);
        return;
      }
      throw new CalendarAuthError('development token is invalid or revoked (invalid_grant)', {
        providerReason: 'invalid_grant',
      });
    }
  }

  private mintTokens(refreshToken: string, previous?: TokenSet): TokenSet {
    return {
      accessToken: this.nextId('dev-access'),
      refreshToken,
      expiresAt: new Date(this.now().getTime() + 3600 * 1000),
      scope: previous?.scope ?? [],
      idTokenEmail: previous?.idTokenEmail ?? this.options.accountEmail ?? 'organiser@dev.simplexd.local',
    };
  }

  buildAuthorizationUrl(input: AuthorizationUrlInput): string {
    // Sends the browser straight back to our callback; the code embeds the PKCE challenge.
    const url = new URL(input.redirectUri);
    url.searchParams.set(
      'code',
      `dev.${input.codeChallenge}.${Buffer.from(input.scopes.join(' ')).toString('base64url')}`,
    );
    url.searchParams.set('state', input.state);
    url.searchParams.set('scope', input.scopes.join(' '));
    url.searchParams.set('dev_adapter', '1');
    return url.toString();
  }

  async exchangeCode(input: ExchangeCodeInput): Promise<TokenSet> {
    const [prefix, challenge, scopesB64] = input.code.split('.');
    if (prefix !== 'dev' || !challenge || scopesB64 === undefined) {
      throw new CalendarAuthError('development authorisation code is malformed (invalid_grant)', {
        providerReason: 'invalid_grant',
        reconnectRequired: true,
      });
    }
    if (codeChallengeS256(input.codeVerifier) !== challenge) {
      throw new CalendarAuthError('PKCE verifier does not match the challenge (invalid_grant)', {
        providerReason: 'invalid_grant',
        reconnectRequired: true,
      });
    }
    const refreshToken = `dev-refresh-${randomBytes(8).toString('hex')}`;
    this.issuedRefreshTokens.add(refreshToken);
    const scope = Buffer.from(scopesB64, 'base64url').toString('utf8').split(' ').filter(Boolean);
    return this.mintTokens(refreshToken, {
      accessToken: '',
      refreshToken,
      expiresAt: null,
      scope,
      idTokenEmail: this.options.accountEmail ?? 'organiser@dev.simplexd.local',
    });
  }

  async refresh(tokens: TokenSet): Promise<TokenSet> {
    if (!tokens.refreshToken || !this.issuedRefreshTokens.has(tokens.refreshToken)) {
      throw new CalendarAuthError('refresh token is unknown or revoked (invalid_grant)', {
        providerReason: 'invalid_grant',
      });
    }
    return this.mintTokens(tokens.refreshToken, tokens);
  }

  async revoke(token: string): Promise<void> {
    this.revokedTokens.add(token);
    this.issuedRefreshTokens.delete(token);
  }

  async listCalendars(credentials: CalendarCredentials): Promise<CalendarSummary[]> {
    this.assertAccess(credentials);
    return [
      {
        id: 'primary',
        summary: 'Development calendar (not Google)',
        primary: true,
        accessRole: 'owner',
        timeZone: this.options.calendarTimeZone ?? 'Africa/Lagos',
      },
    ];
  }

  async freeBusy(credentials: CalendarCredentials, input: FreeBusyInput): Promise<FreeBusyResult> {
    this.assertAccess(credentials);
    const min = new Date(input.timeMin).getTime();
    const max = new Date(input.timeMax).getTime();
    const result: FreeBusyResult = { busy: [], errors: [] };
    for (const calendarId of input.calendarIds) {
      if (calendarId !== 'primary') {
        result.errors.push({ calendarId, reason: 'notFound' });
        continue;
      }
      for (const seed of this.options.seedBusy ?? []) {
        if ((seed.calendarId ?? 'primary') !== calendarId) continue;
        const s = new Date(seed.start).getTime();
        const e = new Date(seed.end).getTime();
        if (s < max && e > min) result.busy.push({ calendarId, start: seed.start, end: seed.end });
      }
      for (const event of this.events.values()) {
        if (event.calendarId !== calendarId || event.status === 'cancelled') continue;
        const s = new Date(event.start).getTime();
        const e = new Date(event.end).getTime();
        if (s < max && e > min) result.busy.push({ calendarId, start: event.start, end: event.end });
      }
    }
    result.busy.sort((a, b) => a.start.localeCompare(b.start));
    return result;
  }

  private meetUrlFor(eventId: string): string {
    const code = createHash('sha256').update(eventId).digest('hex').slice(0, 4);
    return `https://meet.google.com/dev-${code}`;
  }

  private startConference(event: DevEvent, requestId: string): void {
    if (event.failedRequestIds.has(requestId)) {
      // Google ignores a createRequest whose id equals the previous one.
      return;
    }
    const mode = this.conferenceMode;
    if (mode === 'failure' && event.failedRequestIds.size === 0) {
      event.failedRequestIds.add(requestId);
      event.conference = { status: 'failed', meetUrl: null, requestId };
      return;
    }
    if (mode === 'pending') {
      event.pendingPollsLeft = Math.max(1, this.options.pendingPolls ?? 1);
      event.conference = { status: 'pending', meetUrl: null, requestId };
      return;
    }
    event.conference = { status: 'ready', meetUrl: this.meetUrlFor(event.id), requestId };
  }

  private touch(event: DevEvent, bumpSequence: boolean): void {
    event.etagVersion += 1;
    if (bumpSequence) event.sequence += 1;
    event.updated = this.now().toISOString();
    this.changeSeq += 1;
    event.changeSeq = this.changeSeq;
  }

  private toResult(event: DevEvent): EventResult {
    return {
      eventId: event.id,
      etag: etagOf(event.etagVersion),
      sequence: event.sequence,
      htmlLink: `https://calendar.google.com/calendar/dev/${event.id}`,
      status: event.status,
      start: event.start,
      end: event.end,
      updated: event.updated,
      conference: { ...event.conference },
      extendedPrivate: { ...event.extendedPrivate },
    };
  }

  private getOrThrow(calendarId: string, eventId: string): DevEvent {
    const event = this.events.get(eventId);
    if (!event || event.calendarId !== calendarId) {
      throw new CalendarProviderError(`event ${eventId} not found`, { code: 'not_found', httpStatus: 404 });
    }
    return event;
  }

  async createEvent(credentials: CalendarCredentials, input: CreateEventInput): Promise<EventResult> {
    this.assertAccess(credentials);
    if (new Date(input.end).getTime() <= new Date(input.start).getTime()) {
      throw new CalendarProviderError('event end must be after start', { code: 'invalid_request' });
    }
    // Retrying the same operation must not create a duplicate.
    for (const existing of this.events.values()) {
      if (
        existing.status !== 'cancelled' &&
        existing.extendedPrivate[PRIVATE_PROPERTY_KEYS.appointmentId] === input.appointmentId &&
        existing.extendedPrivate[PRIVATE_PROPERTY_KEYS.conferenceRequestId] === input.conferenceRequestId
      ) {
        return this.toResult(existing);
      }
    }
    const id = input.eventId ?? this.nextId('dev-evt');
    const event: DevEvent = {
      id,
      calendarId: input.calendarId,
      summary: input.summary,
      description: input.description ?? null,
      location: input.location ?? null,
      start: new Date(input.start).toISOString(),
      end: new Date(input.end).toISOString(),
      timeZone: input.timeZone,
      attendees: [...input.attendees],
      status: 'confirmed',
      etagVersion: 0,
      sequence: 0,
      updated: this.now().toISOString(),
      extendedPrivate: {
        ...(input.privateProps ?? {}),
        [PRIVATE_PROPERTY_KEYS.appointmentId]: input.appointmentId,
        [PRIVATE_PROPERTY_KEYS.conferenceRequestId]: input.conferenceRequestId,
        [PRIVATE_PROPERTY_KEYS.source]: 'simplexd-dev',
      },
      conference: { status: 'none', meetUrl: null, requestId: null },
      pendingPollsLeft: 0,
      failedRequestIds: new Set(),
      changeSeq: 0,
    };
    if (input.conference ?? true) this.startConference(event, input.conferenceRequestId);
    this.events.set(id, event);
    this.touch(event, false);
    return this.toResult(event);
  }

  async getEvent(
    credentials: CalendarCredentials,
    input: { calendarId: string; eventId: string },
  ): Promise<EventResult> {
    this.assertAccess(credentials);
    const event = this.getOrThrow(input.calendarId, input.eventId);
    if (event.conference.status === 'pending') {
      event.pendingPollsLeft -= 1;
      if (event.pendingPollsLeft <= 0) {
        event.conference = {
          status: 'ready',
          meetUrl: this.meetUrlFor(event.id),
          requestId: event.conference.requestId,
        };
        this.touch(event, false);
      }
    }
    return this.toResult(event);
  }

  private assertEtag(event: DevEvent, etag: string | null): void {
    if (etag !== null && etag !== etagOf(event.etagVersion)) throw new CalendarConflictError();
  }

  async updateEvent(credentials: CalendarCredentials, input: UpdateEventInput): Promise<EventResult> {
    this.assertAccess(credentials);
    const event = this.getOrThrow(input.calendarId, input.eventId);
    this.assertEtag(event, input.etag);
    const { patch } = input;
    let timeChanged = false;
    if (patch.summary !== undefined) event.summary = patch.summary;
    if (patch.description !== undefined) event.description = patch.description;
    if (patch.location !== undefined) event.location = patch.location;
    if (patch.start !== undefined) {
      event.start = new Date(patch.start).toISOString();
      timeChanged = true;
    }
    if (patch.end !== undefined) {
      event.end = new Date(patch.end).toISOString();
      timeChanged = true;
    }
    if (patch.timeZone !== undefined) event.timeZone = patch.timeZone;
    if (patch.attendees !== undefined) event.attendees = [...patch.attendees];
    if (patch.privateProps !== undefined) {
      event.extendedPrivate = {
        ...patch.privateProps,
        [PRIVATE_PROPERTY_KEYS.appointmentId]: event.extendedPrivate[PRIVATE_PROPERTY_KEYS.appointmentId] ?? '',
        [PRIVATE_PROPERTY_KEYS.conferenceRequestId]:
          event.extendedPrivate[PRIVATE_PROPERTY_KEYS.conferenceRequestId] ?? '',
      };
    }
    if (patch.conferenceRequestId !== undefined) {
      event.extendedPrivate[PRIVATE_PROPERTY_KEYS.conferenceRequestId] = patch.conferenceRequestId;
      this.startConference(event, patch.conferenceRequestId);
    }
    if (new Date(event.end).getTime() <= new Date(event.start).getTime()) {
      throw new CalendarProviderError('event end must be after start', { code: 'invalid_request' });
    }
    this.touch(event, timeChanged);
    return this.toResult(event);
  }

  async cancelEvent(
    credentials: CalendarCredentials,
    input: CancelEventInput,
  ): Promise<CancelEventResult> {
    this.assertAccess(credentials);
    const event = this.events.get(input.eventId);
    if (!event || event.calendarId !== input.calendarId || event.status === 'cancelled') {
      return { status: 'already_gone' };
    }
    this.assertEtag(event, input.etag);
    event.status = 'cancelled';
    this.touch(event, true);
    return { status: 'cancelled' };
  }

  async watchEvents(credentials: CalendarCredentials, input: WatchEventsInput): Promise<WatchResult> {
    this.assertAccess(credentials);
    if (this.channels.has(input.channelId)) {
      throw new CalendarProviderError('channel id already in use', { code: 'already_exists', httpStatus: 400 });
    }
    const channel: DevChannel = {
      channelId: input.channelId,
      resourceId: this.nextId('dev-res'),
      calendarId: input.calendarId,
      token: input.token,
      expiration: new Date(this.now().getTime() + Math.max(60, input.ttlSeconds) * 1000),
      messageNumber: 1,
    };
    this.channels.set(channel.channelId, channel);
    return { channelId: channel.channelId, resourceId: channel.resourceId, expiration: channel.expiration };
  }

  async stopChannel(credentials: CalendarCredentials, input: StopChannelInput): Promise<void> {
    this.assertAccess(credentials);
    const channel = this.channels.get(input.channelId);
    if (channel && channel.resourceId === input.resourceId) this.channels.delete(input.channelId);
  }

  async listChanges(
    credentials: CalendarCredentials,
    input: ListChangesInput,
  ): Promise<ListChangesResult> {
    this.assertAccess(credentials);
    let since = 0;
    if (input.syncToken) {
      if (!input.syncToken.startsWith(SYNC_TOKEN_PREFIX)) {
        return { items: [], nextPageToken: null, nextSyncToken: null, fullResyncRequired: true };
      }
      since = Number(input.syncToken.slice(SYNC_TOKEN_PREFIX.length));
      if (!Number.isFinite(since) || since < this.syncTokenFloor) {
        return { items: [], nextPageToken: null, nextSyncToken: null, fullResyncRequired: true };
      }
    }
    const timeMin = !input.syncToken && input.timeMin ? new Date(input.timeMin).getTime() : null;
    const all = [...this.events.values()]
      .filter((e) => e.calendarId === input.calendarId && e.changeSeq > since)
      .filter((e) => timeMin === null || new Date(e.end).getTime() >= timeMin)
      .sort((a, b) => a.changeSeq - b.changeSeq);
    const pageSize = Math.min(Math.max(input.maxResults ?? 250, 1), 2500);
    const offset = input.pageToken?.startsWith(PAGE_TOKEN_PREFIX)
      ? Number(input.pageToken.slice(PAGE_TOKEN_PREFIX.length))
      : 0;
    const page = all.slice(offset, offset + pageSize);
    const items: ChangedEvent[] = page.map((e) => ({
      id: e.id,
      status: e.status,
      start: e.status === 'cancelled' ? null : e.start,
      end: e.status === 'cancelled' ? null : e.end,
      etag: etagOf(e.etagVersion),
      sequence: e.sequence,
      updated: e.updated,
      extendedPrivate: { ...e.extendedPrivate },
    }));
    const hasMore = offset + pageSize < all.length;
    return {
      items,
      nextPageToken: hasMore ? `${PAGE_TOKEN_PREFIX}${offset + pageSize}` : null,
      nextSyncToken: hasMore ? null : `${SYNC_TOKEN_PREFIX}${this.changeSeq}`,
      fullResyncRequired: false,
    };
  }

  async testConnection(credentials: CalendarCredentials): Promise<ConnectionTestResult> {
    const checkedAt = this.now();
    try {
      const calendars = await this.listCalendars(credentials);
      return {
        ok: true,
        accountEmail: credentials.idTokenEmail,
        calendarCount: calendars.length,
        checkedAt,
        message: 'Development calendar adapter (simulated; not Google)',
        reconnectRequired: false,
      };
    } catch (err) {
      return {
        ok: false,
        accountEmail: credentials.idTokenEmail,
        calendarCount: null,
        checkedAt,
        message: err instanceof Error ? err.message : 'development adapter error',
        reconnectRequired: err instanceof CalendarAuthError,
      };
    }
  }
}
