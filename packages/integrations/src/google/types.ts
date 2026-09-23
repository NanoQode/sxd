/**
 * Calendar provider contract (Google Calendar + Google Meet, plus the labelled
 * development adapter). Adapters produce typed inputs/outputs only; persisting
 * `calendar_connections`, `event_syncs` and `calendar_watch_channels` is the
 * application's job.
 *
 * Verified against Google's Calendar v3 discovery document (rev 20260826) and
 * the official Node client; see docs/providers/research/google-calendar-research-2026-09-23.md.
 */

export type CalendarProviderId = 'google' | 'dev';

/** `sendUpdates` values accepted by events.insert/patch/delete (verified, discovery). */
export type SendUpdates = 'all' | 'externalOnly' | 'none';

/** Mirrors the `conference_status` database enum. */
export type ConferenceStatus = 'none' | 'pending' | 'ready' | 'failed';

export type EventStatus = 'confirmed' | 'tentative' | 'cancelled';

/** OAuth scopes (URLs verified from the discovery document's per-method scope lists). */
export const GOOGLE_SCOPES = {
  calendarListReadonly: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  /** "View your availability in your calendars" — accepted by freebusy.query. */
  freeBusy: 'https://www.googleapis.com/auth/calendar.freebusy',
  /** Also accepted by events.list/get/watch (free/busy for calendars the user can access). */
  eventsFreeBusy: 'https://www.googleapis.com/auth/calendar.events.freebusy',
  /** Narrowest write scope: events on calendars the organiser owns (e.g. `primary`). */
  eventsOwned: 'https://www.googleapis.com/auth/calendar.events.owned',
  /** Needed only when the chosen calendar is a shared/team calendar the organiser does not own. */
  events: 'https://www.googleapis.com/auth/calendar.events',
  openid: 'openid',
  email: 'email',
} as const;

/** Minimal scope set for a booking organiser using a calendar they own. */
export const DEFAULT_GOOGLE_SCOPES: readonly string[] = [
  GOOGLE_SCOPES.calendarListReadonly,
  GOOGLE_SCOPES.freeBusy,
  GOOGLE_SCOPES.eventsOwned,
  GOOGLE_SCOPES.openid,
  GOOGLE_SCOPES.email,
];

/** Scope set when the organiser books into a shared calendar they can write to but do not own. */
export const SHARED_CALENDAR_GOOGLE_SCOPES: readonly string[] = [
  GOOGLE_SCOPES.calendarListReadonly,
  GOOGLE_SCOPES.eventsFreeBusy,
  GOOGLE_SCOPES.events,
  GOOGLE_SCOPES.openid,
  GOOGLE_SCOPES.email,
];

/** Granular consent may grant fewer scopes than requested; check before marking `connected`. */
export function missingScopes(granted: readonly string[], required: readonly string[]): string[] {
  const have = new Set(granted);
  return required.filter((scope) => {
    if (have.has(scope)) return false;
    // openid/email are sometimes returned as full userinfo URLs.
    if (scope === 'email') return !have.has('https://www.googleapis.com/auth/userinfo.email');
    return true;
  });
}

export interface TokenSet {
  accessToken: string;
  /** Only returned on the first consent (access_type=offline + prompt=consent); keep the stored one otherwise. */
  refreshToken: string | null;
  /** Absolute expiry derived from Google's `expires_in`; null when unknown. */
  expiresAt: Date | null;
  /** Scopes actually granted (space-delimited `scope` field, split). */
  scope: string[];
  /** Email from the ID token when `openid email` was granted; identifies the organiser account. */
  idTokenEmail: string | null;
}

/**
 * Credentials passed to every API call. The Google client refreshes access
 * tokens lazily and emits a `tokens` event; `onRotated` receives the merged,
 * persisted-ready token set so the caller can store it (encrypted) at once.
 */
export interface CalendarCredentials extends TokenSet {
  onRotated?: (next: TokenSet) => void | Promise<void>;
}

export interface AuthorizationUrlInput {
  redirectUri: string;
  /** Signed CSRF state (see state.ts). */
  state: string;
  /** PKCE S256 challenge (see state.ts). */
  codeChallenge: string;
  scopes: readonly string[];
  loginHint?: string;
}

export interface ExchangeCodeInput {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

export interface CalendarSummary {
  id: string;
  summary: string;
  primary: boolean;
  /** freeBusyReader | reader | writer | owner */
  accessRole: string;
  timeZone: string | null;
}

export interface FreeBusyInput {
  calendarIds: string[];
  /** RFC3339 */
  timeMin: string;
  /** RFC3339 */
  timeMax: string;
  timeZone?: string;
}

export interface BusyPeriod {
  calendarId: string;
  /** RFC3339, inclusive */
  start: string;
  /** RFC3339, exclusive */
  end: string;
}

export interface FreeBusyResult {
  /** Busy intervals only. Event titles are never requested or exposed. */
  busy: BusyPeriod[];
  /** Per-calendar failures (`notFound`, `internalError`, …); the HTTP call itself succeeds. */
  errors: Array<{ calendarId: string; reason: string }>;
}

export interface EventAttendee {
  email: string;
  displayName?: string;
  optional?: boolean;
}

export interface EventReminder {
  method: 'email' | 'popup';
  /** 0–40320 (4 weeks) */
  minutes: number;
}

export interface CreateEventInput {
  calendarId: string;
  /** Our appointment id; stored in extendedProperties.private.simplexdAppointmentId. */
  appointmentId: string;
  /** New per booking; reuse only when retrying the same operation. */
  conferenceRequestId: string;
  /**
   * Optional deterministic event id (base32hex, 5–1024 chars). When omitted the
   * adapter derives one from appointmentId + conferenceRequestId so a retried
   * insert cannot create a duplicate event.
   */
  eventId?: string;
  summary: string;
  description?: string;
  location?: string;
  /** RFC3339 instant (UTC or with offset). */
  start: string;
  /** RFC3339 instant (UTC or with offset). */
  end: string;
  /** IANA zone the event is displayed in (business zone). */
  timeZone: string;
  attendees: EventAttendee[];
  sendUpdates: SendUpdates;
  /** Extra private properties (string map) stored on our copy of the event. */
  privateProps?: Record<string, string>;
  reminders?: EventReminder[];
  /** Create a Google Meet conference (default true). */
  conference?: boolean;
}

export interface ConferenceInfo {
  status: ConferenceStatus;
  /** The `video` entry point URI (https://meet.google.com/xxx-xxxx-xxx) once ready. */
  meetUrl: string | null;
  requestId: string | null;
}

export interface EventResult {
  eventId: string;
  etag: string;
  sequence: number;
  htmlLink: string | null;
  status: EventStatus;
  start: string | null;
  end: string | null;
  updated: string | null;
  conference: ConferenceInfo;
  extendedPrivate: Record<string, string>;
}

export interface EventPatch {
  summary?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
  timeZone?: string;
  attendees?: EventAttendee[];
  /** Replaces our private property map (Google patch semantics for nested maps are not verified). */
  privateProps?: Record<string, string>;
  reminders?: EventReminder[];
  /** Retry conference creation with a NEW request id after a `failed` status. */
  conferenceRequestId?: string;
}

export interface UpdateEventInput {
  calendarId: string;
  eventId: string;
  /** Sent as If-Match; null skips the precondition (use only for reconciliation after a reload). */
  etag: string | null;
  patch: EventPatch;
  sendUpdates: SendUpdates;
}

export interface CancelEventInput {
  calendarId: string;
  eventId: string;
  etag: string | null;
  sendUpdates: SendUpdates;
}

export interface CancelEventResult {
  status: 'cancelled' | 'already_gone';
}

export interface WatchEventsInput {
  calendarId: string;
  /** UUID generated by us; stored in calendar_watch_channels.channel_id. */
  channelId: string;
  /** HTTPS receiver on a verified domain. */
  address: string;
  /** Random secret echoed back in X-Goog-Channel-Token; store only its hash. */
  token: string;
  /** Requested lifetime. Google may shorten it; read `expiration` from the result. */
  ttlSeconds: number;
}

export interface WatchResult {
  channelId: string;
  resourceId: string;
  expiration: Date | null;
}

export interface StopChannelInput {
  channelId: string;
  resourceId: string;
}

export interface ListChangesInput {
  calendarId: string;
  /** Incremental sync token from the previous run; omit for a full sync. */
  syncToken?: string | null;
  pageToken?: string | null;
  /** Only for the initial full sync (timeMin cannot be combined with syncToken). */
  timeMin?: string | null;
  maxResults?: number;
}

export interface ChangedEvent {
  id: string;
  status: EventStatus;
  start: string | null;
  end: string | null;
  etag: string | null;
  sequence: number | null;
  updated: string | null;
  extendedPrivate: Record<string, string>;
}

export interface ListChangesResult {
  items: ChangedEvent[];
  nextPageToken: string | null;
  /** Present only on the last page; persist it after draining all pages. */
  nextSyncToken: string | null;
  /** HTTP 410 GONE: drop the stored token and local copy, then run a full sync. */
  fullResyncRequired: boolean;
}

export interface ConnectionTestResult {
  ok: boolean;
  accountEmail: string | null;
  calendarCount: number | null;
  checkedAt: Date;
  /** Sanitised, safe to show in the admin console. */
  message: string;
  reconnectRequired: boolean;
}

export interface CalendarProvider {
  readonly id: CalendarProviderId;
  buildAuthorizationUrl(input: AuthorizationUrlInput): string;
  exchangeCode(input: ExchangeCodeInput): Promise<TokenSet>;
  refresh(tokens: TokenSet): Promise<TokenSet>;
  revoke(token: string): Promise<void>;
  listCalendars(credentials: CalendarCredentials): Promise<CalendarSummary[]>;
  freeBusy(credentials: CalendarCredentials, input: FreeBusyInput): Promise<FreeBusyResult>;
  createEvent(credentials: CalendarCredentials, input: CreateEventInput): Promise<EventResult>;
  getEvent(
    credentials: CalendarCredentials,
    input: { calendarId: string; eventId: string },
  ): Promise<EventResult>;
  updateEvent(credentials: CalendarCredentials, input: UpdateEventInput): Promise<EventResult>;
  cancelEvent(credentials: CalendarCredentials, input: CancelEventInput): Promise<CancelEventResult>;
  watchEvents(credentials: CalendarCredentials, input: WatchEventsInput): Promise<WatchResult>;
  stopChannel(credentials: CalendarCredentials, input: StopChannelInput): Promise<void>;
  listChanges(credentials: CalendarCredentials, input: ListChangesInput): Promise<ListChangesResult>;
  testConnection(credentials: CalendarCredentials): Promise<ConnectionTestResult>;
}

/** Private extended property keys written on every event we create. */
export const PRIVATE_PROPERTY_KEYS = {
  appointmentId: 'simplexdAppointmentId',
  conferenceRequestId: 'simplexdConferenceRequestId',
  source: 'simplexdSource',
} as const;
