# Google Workspace (Calendar + Meet) setup

Adapter: `packages/integrations/src/google` (`@simplexd/integrations/google`). Research and
verification ledger: `docs/providers/research/google-calendar-research-2026-09-23.md`.
Everything below marked **verified** was checked against Google's Calendar v3 discovery
document (rev 20260826) and the official Node client; items marked **unverified** come from
search snippets of the (blocked) guide pages and must be confirmed during live sandbox
testing.

## 1. Google Cloud project

1. Create (or pick) a Google Cloud project owned by the business, not a personal account.
2. **APIs & Services → Library → Google Calendar API → Enable.** Google Meet links are created
   through the Calendar API (`conferenceData.createRequest`); no separate Meet API is needed.
3. **Google Auth Platform / OAuth consent screen**
   - User type: _Internal_ if every organiser is in the company's Workspace domain (no
     verification, no 100-user cap), otherwise _External_.
   - App name, support email, privacy policy and terms URLs (the public site's policy pages).
   - Authorised domains: the production domain (`simplexd.co`) and any staging domain.
   - **Data access / scopes**: add the scopes listed in §3. The console labels each as
     non-sensitive / sensitive / restricted and states whether verification is required
     (**unverified**: expect the event scopes to be _sensitive_ → verification + privacy
     policy; while an External app is in _Testing_, grants expire after **7 days** — verified
     from the client README — so do not leave production in Testing).
4. **Credentials → Create credentials → OAuth client ID → Web application**
   - Authorised redirect URI, exactly: `${APP_URL}/api/v1/admin/integrations/google/callback`
     (scheme, host, case and trailing slash must match — verified). Add one entry per
     environment (staging and production are separate OAuth clients, never shared).
   - Copy the client ID and the client secret (`GOCSPX-…`). The secret is entered once in
     Admin → Integrations → Google Workspace as a **write-only** field; it is envelope-encrypted
     (`secret_references`) and only masked presence/last-rotation metadata is readable.

A client ID and secret alone is `configured_unverified`. The integration only becomes
`connected` after an organiser completes the consent flow and a test call succeeds.

## 2. Organiser consent flow (server-side authorisation code + PKCE)

1. Admin clicks **Connect organiser**. The server calls `beginAuthorization(secret)` (state
   nonce, HMAC-signed state with issued-at, PKCE S256 pair) and stores `state` +
   `codeVerifier` bound to the admin session (short TTL, ≤10 min).
2. `provider.buildAuthorizationUrl({ redirectUri, state: signedState, codeChallenge, scopes })`
   → `https://accounts.google.com/o/oauth2/v2/auth` with `access_type=offline`,
   `prompt=consent`, `include_granted_scopes=true`, `code_challenge_method=S256` (verified).
   `prompt=consent` is deliberate: Google returns the refresh token **only on the first
   consent** (verified), so a reconnect must force consent again.
3. Callback: `verifyState(signedState, secret)` (constant-time, max age), match the nonce to
   the session, then `provider.exchangeCode({ code, redirectUri, codeVerifier })` →
   `TokenSet { accessToken, refreshToken, expiresAt, scope[], idTokenEmail }`.
4. Check `missingScopes(tokens.scope, requested)` — granular consent may grant fewer scopes
   (**unverified**); refuse to mark `connected` until every required scope is present.
5. Persist: refresh token and access token encrypted (`calendar_connections.refresh_token_secret_id`,
   `access_token_secret_id`), `access_token_expires_at`, `account_email = idTokenEmail`,
   `scopes`, `status = connected`, `connected_at`.
6. Admin chooses the calendar from `listCalendars` (prefer `primary` or a calendar with
   `accessRole` writer/owner) and configures working hours, duration, buffers, holidays and
   staff routing (`booking_settings`, `staff_availability`).

Customers never connect Google accounts; bookings go through the organiser's grant. Domain-wide
delegation is not used.

## 3. Scopes (minimal)

`DEFAULT_GOOGLE_SCOPES` (verified per-method scope lists):

| Scope                            | Why                                                                   |
| -------------------------------- | --------------------------------------------------------------------- |
| `calendar.calendarlist.readonly` | choose the booking calendar                                           |
| `calendar.freebusy`              | availability without event titles                                     |
| `calendar.events.owned`          | create/patch/delete/watch/list events on calendars the organiser owns |
| `openid email`                   | identify the connected account (ID token email)                       |

Use `SHARED_CALENDAR_GOOGLE_SCOPES` (`calendar.events` + `calendar.events.freebusy`) only when
the booking calendar is a shared calendar the organiser does not own.

## 4. Token health, refresh and reconnect

- Every API call creates a fresh OAuth2 client with the stored tokens and captures the
  library's `tokens` event; rotated tokens are delivered to `credentials.onRotated` and must
  be persisted immediately (the newest refresh token always wins; Google keeps a per-client
  cap of refresh tokens, **unverified** number).
- `provider.refresh(tokens)` is used by the health check job; the library also refreshes
  lazily within 5 minutes of expiry (verified).
- `CalendarAuthError` (`invalid_grant`, 401, 403 with missing scopes) ⇒ set the connection to
  `expired`, stop scheduling sync jobs, show `error.instructions` in the admin console
  (reconnect from Admin → Integrations → Google Workspace). Causes (verified from the client
  README): grant revoked, refresh token unused for 6 months, Testing-status expiry, token cap.
- `revoke(token)` calls `https://oauth2.googleapis.com/revoke`; a 400 (already revoked) is
  treated as success. Disconnect = revoke + delete secrets + `status = disconnected`.
- `testConnection` returns a sanitised message (tokens are redacted by
  `sanitizeErrorMessage`) for `last_check_ok` / `last_error_sanitized`.

## 5. Booking, Meet and reschedule/cancel

- Availability: `computeSlots` combines working hours (business zone), holidays, Google
  free/busy (`freeBusy`, never event titles), platform `slot_reservations` (holds,
  appointments, leave, blocks) and buffers. The database exclusion constraint on
  `slot_reservations` is the arbiter for concurrent bookings; availability is rechecked
  (`isSlotAvailable`) before confirmation. Google races are reconciled, not prevented.
- `createEvent` sends `conferenceDataVersion=1`, `conferenceData.createRequest { requestId,
conferenceSolutionKey.type = 'hangoutsMeet' }`, attendees with `responseStatus: needsAction`,
  `sendUpdates`, start/end with `timeZone`, and `extendedProperties.private.simplexdAppointmentId`
  (all verified). The event id is derived from `appointmentId + conferenceRequestId`, so a
  retried insert returns the existing event (409 → get) instead of duplicating it. Store
  `event_syncs.provider_event_id`, `etag`, `sequence`, `conference_request_id`.
- Conference creation is asynchronous: `conference.status` is `pending` until `getEvent`
  returns a `video` entry point (`ready`). Poll from a job; show the **Join** button only when
  `ready`. `failed` ⇒ retry with `updateEvent({ patch: { conferenceRequestId: <new id> } })`
  (a repeated request id is ignored by Google — verified). Never invent a Meet link; while
  Google is unavailable keep the sync visibly pending and offer the ICS download (`buildIcs`).
- Reschedule: `updateEvent` with the stored `etag` (sent as `If-Match`); 412 ⇒
  `CalendarConflictError` ⇒ reload with `getEvent`, reconcile, retry with the fresh etag.
- Cancel: `cancelEvent` with `If-Match`; 404/410 ⇒ `already_gone`. Release the reservation and
  notify attendees (`sendUpdates: all`).

## 6. Push notifications and incremental sync

- `watchEvents` creates a `web_hook` channel (`id` = our UUID, `token` = random secret,
  `expiration` = now + ttl). Store `channel_id`, `resource_id`, `token_hash`
  (`hashChannelToken`), `expiration` in `calendar_watch_channels`.
- Receiver requirements (**unverified** wording, standard practice): HTTPS with a valid
  certificate and the domain verified for the Cloud project (Search Console → then
  APIs & Services → Domain verification). Self-signed certificates and localhost are rejected,
  so push is production/staging only; development uses polling.
- Webhook route: `validatePushNotification(headers, lookupTokenHash)`; the request has **no
  body** — never derive event details from it. On `exists`/`not_exists` enqueue a sync job;
  always respond 2xx quickly (Google retries only on 5xx). `sync` messages just confirm the
  channel.
- Sync job: `listChanges({ calendarId, syncToken })` with `showDeleted=true`,
  `singleEvents=true` (verified requirements); drain all `nextPageToken` pages and persist
  `nextSyncToken` only from the last page. `fullResyncRequired` (HTTP 410) ⇒ clear the token
  and run a full sync with `timeMin`. Cancelled items only guarantee `id`; match them to
  `event_syncs.provider_event_id` and mark the appointment `conflict` for staff review if the
  organiser deleted a booked event.
- Renewal: channels do not auto-renew and the maximum lifetime is **unverified** (default
  `ttl` 604800 s per snippets). The scheduler re-watches anything with
  `channelNeedsRenewal(expiration)` (24 h window) and then `stopChannel` on the old one.

## 7. Time zones and DST

Storage is UTC. Working hours are interpreted in the business zone (`Africa/Lagos`, no DST);
customer displays use their own zone with DST-aware conversion (`dualZoneLabel`). Tests cover
the America/Toronto transitions on 2026-03-08 and 2026-11-01: the same 09:00 WAT slot is
04:00 EDT before and 03:00 EST after 1 November. Events are sent to Google as UTC instants plus
the business `timeZone`, so Google's UI shows the intended wall-clock time.

## 8. Development adapter

`DevCalendarProvider` (selected automatically when no client ID/secret is configured and
`APP_ENV` is `development`/`test`; refused elsewhere) simulates PKCE exchange, revocation,
free/busy, `dev-xxxx` Meet links (only when the simulated conference is `ready`), pending
conferences that become ready after N polls, one-shot failures that succeed with a new request
id, 412 conflicts on stale etags, watch channels (`simulateNotificationHeaders`) and sync
tokens with `expireSyncTokens()` for the 410 path. Its Meet links do not resolve; label them.

## 9. Verified vs unverified summary

| Item                                                                                                                                 | Status                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| OAuth endpoints, params, refresh-token-on-first-consent, PKCE S256, revoke URL                                                       | verified                                                  |
| Scope URLs and per-method acceptance                                                                                                 | verified                                                  |
| freebusy.query, events.insert/patch/delete params, `conferenceDataVersion`, `requestId`, `hangoutsMeet`, status codes, `sendUpdates` | verified                                                  |
| `If-Match`/412 semantics                                                                                                             | header pass-through verified; 412 behaviour from snippets |
| events.watch/channels.stop schema                                                                                                    | verified                                                  |
| Notification header names/states, no payload, HTTPS/domain verification, retry policy, channel max lifetime                          | unverified                                                |
| syncToken rules, `showDeleted` requirement, 410 ⇒ full sync                                                                          | verified                                                  |
| Scope sensitivity labels / verification thresholds                                                                                   | unverified                                                |
