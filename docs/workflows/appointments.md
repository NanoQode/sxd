# Appointments, booking holds and Google Calendar / Meet sync

Code: `apps/web/src/server/appointments`, `apps/web/src/server/calendar`,
`apps/worker/src/handlers/calendar.ts`, contracts in `packages/contracts/src/appointments.ts`.
Provider adapter and Google setup: `packages/integrations/src/google`, `docs/providers/google-workspace.md`.

## Journey

```
availability ──► hold (10 min, EXCLUDE-guarded) ──► book (idempotent) ──► calendar.sync_event
                                                          │                    │
                                                          │        pending Meet ─► calendar.reconcile_pending_conferences ─► ready
                                                          │        failed Meet  ─► staff retry-sync (new request id)
            reschedule (new hold, atomic swap) ──► calendar.sync_event (If-Match etag; 412 ⇒ re-read, retry)
            cancel (reason) ──► capacity released ──► calendar.cancel_event
```

1. **Availability** `GET /api/v1/appointments/availability?kind=&staffUserId?=&from=&to=&tz=`
   - Windows: `staff_availability` rows (ISO weekday 1–7, `HH:mm` in the staff member's zone,
     optional `kinds`). With no rows, the connected organiser works the global
     `working_hours` setting.
   - Minus: unexpired holds, appointments, leave/blocks (`slot_reservations`) and, when the
     staff member connected Google, their free/busy periods (busy times only, never titles).
     `providerBusyIncluded` says whether that call succeeded.
   - `booking_settings`: duration per kind (`consultation_duration_minutes`,
     `duration_minutes_by_kind`), `buffer_minutes`, `min_notice_hours`, `max_days_ahead`,
     `holidays`, `hold_ttl_minutes`, `auto_confirm`, `guest_kinds`, `reminder_hours`, `routing`.
   - Output: UTC instants plus `dualZoneLabel` for the business and customer zones. Wall-clock
     windows are converted with luxon, so 09:00 Lagos stays 08:00 UTC all year while a London
     customer sees 09:00 BST / 08:00 GMT across 25 Oct 2026 (tested).
   - Anonymous callers only see guest-bookable kinds (default: consultation); rate limited per
     hashed IP.

2. **Hold** `POST /api/v1/appointments/holds` `{kind, staffUserId?, start, customerTimeZone}`
   - Rechecks the slot against windows and busy intervals, picks the staff member (round robin:
     fewest reservations that day), deletes expired holds, inserts a `slot_reservations` row of
     kind `hold` with `expires_at` and an opaque `holdToken` (the kind is stored in `note`).
   - Concurrency: the `slot_reservations_no_overlap` EXCLUDE constraint rejects an overlapping
     reservation for the same staff member. SQLSTATE `23P01` is mapped to `slot_unavailable`
     (409). The integration test fires two holds for one slot and asserts exactly one wins.
   - The scheduler's `bookings.expire_holds` sweeps expired holds every minute; holds are also
     purged when a new hold is taken.

3. **Book** `POST /api/v1/appointments` (`Idempotency-Key` supported)
   - Locks the hold `FOR UPDATE`, refuses expired/consumed holds, converts the reservation to
     kind `appointment`, inserts the appointment (`confirmed` when `auto_confirm`, else
     `pending_confirmation`), an `event_syncs` row with a fresh `conferenceRequestId`, enqueues
     `calendar.sync_event` (dedupe `calendar.sync_event:<id>:v<syncVersion>`) and appends the
     outbox event `appointment.booked` — all in one transaction.
   - Guests (no session) may book `guest_kinds` only and must give name, email and E.164
     phone; rate limited per IP (5/h) and per email (3/h). Signed-in customers are linked to
     their active organisation and their profile phone.
   - Response includes `managePath` (guest self-service link) and `icsPath`. `meetingUrl` is
     null until the provider confirms a Meet; the response never invents one.

4. **Reschedule / cancel**
   - `POST /api/v1/appointments/{id}/reschedule` `{holdToken}` and
     `POST /api/v1/appointments/manage/{token}/reschedule`: the old reservation is deleted and
     the hold promoted in one transaction (atomic swap), status → `rescheduled`, version +1,
     reminders reset, `event_syncs.syncVersion` +1 and a new sync job. Customers/guests must
     respect `min_notice_hours` (`deadline_passed` otherwise); staff may override.
   - `POST …/cancel` `{reason}` uses `appointmentMachine`, releases the reservation and
     enqueues `calendar.cancel_event` when a provider event exists.
   - `POST …/confirm` (staff) and `POST …/retry-sync` (staff with `appointments.manage_all`):
     re-run a failed sync or request a new Meet after a failed conference.
   - `GET /api/v1/appointments/{id}/ics?token=` — text/calendar fallback that works while the
     Google sync is pending; includes the Meet URL only once `ready`.

5. **Visibility**
   - Staff with `appointments.manage_all`: everything (`staffUserId`, `scope=mine` filters).
     Other staff, partners and inspectors: appointments they organise. Customers: their own
     bookings plus organisation appointments when their role has `org.appointments.manage`.
     Guests: the manage token. Row-level security (`appointments` policy) backs these rules.
   - `meetingUrl` is exposed only to those viewers and only while the appointment is active
     and the conference is `ready`. Staff also see the sanitised sync record.

## Worker jobs (`queue: calendar`)

| Job                                      | Trigger                            | Behaviour                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calendar.sync_event`                    | book, reschedule, retry, reconnect | Create (`createEvent` with the stored `conferenceRequestId`, attendees, business `timeZone`, `hangoutsMeet` only for virtual kinds) or patch (`If-Match` etag; `CalendarConflictError` ⇒ `getEvent` then retry). Persists event id, calendar id, etag, sequence, conference status/URL. `retryConference` sends a NEW request id. |
| `calendar.cancel_event`                  | cancel                             | `cancelEvent` with etag (412 ⇒ re-read and retry); 404 ⇒ `already_gone`; both close the sync as `cancelled`.                                                                                                                                                                                                                      |
| `calendar.reconcile_pending_conferences` | scheduler, every 2 min             | `getEvent` for pending conferences; records `ready` (Join button appears) or `failed` (visible to staff, retryable).                                                                                                                                                                                                              |
| `calendar.renew_watch_channels`          | scheduler, hourly                  | Re-watches channels expiring within 24 h (`channelNeedsRenewal`), carries the sync token forward, stops the old channel. Skipped unless `APP_URL` is HTTPS (Google refuses other receivers).                                                                                                                                      |
| `calendar.process_push`                  | `POST /api/v1/calendar/push`       | Incremental `listChanges` with the stored `syncToken` (410 ⇒ full resync from now−7d). Organiser-side deletions/moves mark the appointment `conflict` and emit `appointment.sync_conflict`; platform times are never overwritten blindly.                                                                                         |
| `appointments.scan_reminders`            | scheduler, every 5 min             | Emits `appointment.reminder_due` once per `reminder_hours` entry (default 24 h and 1 h); routed to `notifications.send_due_reminders`.                                                                                                                                                                                            |

Outbox events: `appointment.booked`, `appointment.confirmed`, `appointment.rescheduled`,
`appointment.cancelled`, `appointment.sync_conflict`, `appointment.reminder_due` (routes in
`apps/worker/src/outbox.ts`, notifications only — calendar jobs are enqueued in the booking
transaction so a job exists iff the change committed).

### Failure handling

- Every provider failure is stored sanitised (`event_syncs.last_error_sanitized`, `attempts`)
  and mirrored as `appointments.calendar_sync_status = failed`; the job retries with the
  queue's backoff. Customers see "sync pending/failed, use the calendar download"; staff see
  the error and can retry.
- `CalendarAuthError` (`invalid_grant`, 401, missing scopes) marks the connection `expired`
  with reconnect instructions, the job becomes non-retryable, and reconnecting re-enqueues
  every failed sync.
- Meet creation reported as `failed` by Google is visible on the appointment; `retry-sync`
  sends a new `conferenceRequestId` (a repeated id is ignored by Google). Retrying the same
  operation reuses the same id and a deterministic event id, so no duplicate events or Meets.

## Organiser connection (staff, `appointments.manage_all`)

- `GET /api/v1/calendar/connect[?redirect=1]` → `beginAuthorization` (PKCE S256 + HMAC-signed
  state). The nonce, verifier and user id live in a signed HttpOnly cookie for ≤10 min.
- `GET /api/v1/calendar/callback` → verifies state and cookie, `exchangeCode`, checks
  `missingScopes` (fewer scopes ⇒ `degraded`), picks the primary/writable calendar, stores the
  refresh and access tokens envelope-encrypted in `secret_references` (old ones retired),
  runs a check and redirects to `/admin/integrations/google-workspace?calendar=<status>`.
  **Redirect URI to register in Google Cloud:** `${APP_URL}/api/v1/calendar/callback`
  (shown in the admin status; it differs from the `GOOGLE_OAUTH_REDIRECT_PATH` env default).
- `POST /api/v1/calendar/disconnect` → revoke, retire secrets, stop channels, `disconnected`.
- Admin: `GET /api/v1/admin/calendar/status` (adapter, `clientConfigured` vs connected grants,
  scopes, last check, remedies, watch channel, sync counts), `POST …/connections/{id}/check`,
  `POST /api/v1/admin/calendar/test-booking` (`appointments.test_booking`): creates a 15-minute
  event with a Meet request through the real provider, reads it back and deletes it, reporting
  exactly what the provider returned.
- Client id/secret are read from the active `integration_configs` row for
  `google_workspace` (`settings.clientId`, secret field `clientSecret`) with `GOOGLE_CLIENT_ID`
  / `GOOGLE_CLIENT_SECRET` as an environment fallback. Without them, `APP_ENV`
  development/test uses the labelled `DevCalendarProvider` (simulated Meet links);
  production refuses to run.

## Tests

`pnpm --filter @simplexd/web exec vitest run --project web-integration src/server/appointments src/server/calendar`

- `server/appointments/booking.int.test.ts`: windows and buffers, Lagos ↔ London DST labels
  across 25 Oct 2026, concurrent hold race (one winner), hold expiry, guest booking and manage
  token, atomic reschedule, organisation isolation, notice policy and cancellation.
- `server/calendar/sync.int.test.ts` (dev adapter, worker engine imported directly): pending
  Meet → reconcile → ready, one-shot Meet failure → retry with new request id, etag update and
  stale-etag recovery, cancel, reminders, OAuth connect/disconnect with encrypted tokens,
  watch channel + push validation + conflict detection + 410 resync, admin status/check/test
  booking, `invalid_grant` ⇒ expired connection.
