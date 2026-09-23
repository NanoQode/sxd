# Notification delivery workflow

Package: `packages/notifications` (`@simplexd/notifications`), shared by the worker
(`apps/worker/src/handlers/notifications.ts`) and the web API (`apps/web/src/app/api/v1/notifications`,
`.../admin/notifications`, `.../webhooks/termii`). Adapters live in `packages/integrations`
(`mail`, `sms`, `templates`); provider setup is documented in `docs/providers/smtp.md` and
`docs/providers/termii.md`.

## 1. Flow

```
business change ──▶ outbox_events ──▶ worker relay ──▶ jobs (notifications.dispatch, legacy notifications.*)
                                                            │
                                                            ▼
                                     registry.ts: event type → template key, category, channels, recipients
                                                            │
                                                            ▼
                     dispatch.ts per recipient × channel: policy → template → render → delivery_attempts → send
                                                            │
                        ┌───────────────┬───────────────────┼─────────────────────┐
                        ▼               ▼                   ▼                     ▼
                   email (SMTP)     SMS (Termii)        in_app (notifications)   deferred job (quiet hours)
```

1. **Events.** Domain code appends an outbox row inside its transaction (`appendOutbox`). The
   relay (`apps/worker/src/outbox.ts`) turns it into one job per route. Legacy per-event job types
   (`notifications.lead_created`, `notifications.invoice_issued`, ...) and the generic
   `notifications.dispatch` all run the same handler.
2. **Registry** (`registry.ts`) maps event types to a `NotificationRequest`: template key,
   category, channels and recipient specs. Unknown event types are logged and ignored, never
   thrown. Consumed events: `notification.requested` (generic; payload `templateKey|kind`,
   `userId|email|phone`, `variables`, `category`, `channels`), `lead.created`, `lead.invited`,
   `service_request.transitioned` / `engagement.transitioned`, `invitation.created`,
   `quote.issued`, `invoice.issued`, `payment.verified` / `payment.settled`,
   `appointment.booked|confirmed|rescheduled|cancelled|reminder_due|sync_conflict`,
   `report.released` / `project.report.released`, `change_order.submitted`, `tender.published`,
   `award.published`, `work_order.transitioned`, `task.assigned`, `message.posted`,
   `project.status_changed`, `setup_token.issued`.
3. **Recipients** (`recipients.ts`) are resolved from `user` + `user_profiles` (email, phone,
   time zone, locale, marketing consent). Customer recipients are organisation owners, approvers
   and members plus the named contact; staff alerts go to active `operations_manager` /
   `super_admin` role holders.
4. **Policy** (`policy.ts`), per channel:
   - suppressions (`suppressions`: bounce, complaint, STOP) block the channel for every category,
     including security;
   - security messages otherwise always send;
   - the preference matrix (`notification_preferences`, channel × category) with product
     defaults (marketing off, SMS only for security + transactional);
   - a `daily`/`weekly` digest preference records the attempt as `suppressed` with reason
     `digest:<period>` and the in-app row feeds the next digest;
   - quiet hours (preference row, or the `notifications.quiet_hours` setting when the user has
     no rows) defer non-security email/SMS to the end of the window in the recipient's zone;
   - SMS also needs consent (`sms_consents`: marketing opt-in, no transactional opt-out), an
     enabled Termii purpose and headroom under the daily spend cap (`evaluateSendPolicy`).
5. **Templates** (`templates.ts`) come from the `templates` table: highest approved version for
   key/channel/locale (falls back to `en`). Outside production a draft may be used and its
   output is labelled `[DRAFT TEMPLATE]`. Rendering is strict: a missing variable produces a
   `failed` attempt with `missing_variables: ...`, never a blank message. Email gets the branded
   layout from `renderEmail`; SMS records its segment count and estimated cost.
6. **Attempts** (`delivery_attempts`) are written as the system actor with
   `dedupe_key = <scope>:<recipient>:<channel>` where the scope is `outbox:<event id>` (or a
   business key such as `invitation:<org>:<email>` so two events describing the same message
   collapse). A replayed event finds the row and does nothing. Status vocabulary:
   `queued → accepted (SMS taken by provider) / sent (SMTP 250) → delivered (receipt only)`,
   `failed`, `suppressed`, `bounced`, `rejected`. Provider ids, sanitised provider text, segments
   and cost are stored; secrets and raw request bodies never are.
7. **Providers** (`providers.ts`) are resolved per pipeline call from the active
   `integration_configs` row (`smtp` / `termii`, `live` in production, else `test`) with
   decrypted secrets from `loadIntegrationConfig`. Outside production, with no active real
   configuration, the labelled development adapters (in-memory outbox) are used. In production
   with no configuration the attempt fails with `provider_not_configured`, visible in the
   delivery log. Retryable provider errors leave the attempt `queued` and fail the job so the
   queue retries with backoff; permanent errors mark it `failed`.
8. **In-app** rows (`notifications`) carry `dedupe_key`, category, link path and entity, and are
   read through the feed API under the user's own row-level security context.

## 2. Jobs and schedules

| Job type                                                       | Source                                   | Purpose                                                                                                              |
| -------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `notifications.dispatch` (+ legacy `notifications.*`)          | outbox relay                             | Resolve the event through the registry and deliver.                                                                  |
| `notifications.send_deferred` (queue `notifications-deferred`) | dispatch (quiet hours)                   | Carries the rendered message and attempt id; `run_at` is the send time. Claimed by the reminder sweep.               |
| `notifications.send_due_reminders`                             | scheduler (every minute) / calendar scan | Scheduled tick: send deferred attempts whose time has passed. With an `appointment.reminder_due` event: dispatch it. |
| `notifications.send_digests`                                   | scheduler (every 15 minutes)             | One digest email per user per period bundling unread in-app items (`digest` template).                               |
| `notifications.process_bounce`                                 | manual / future provider webhook         | Mark the attempt `bounced`, suppress hard bounces and complaints.                                                    |

Booking reminders are emitted by the calendar scan (`appointments.scan_reminders` →
`appointment.reminder_due`) and delivered with the `booking_reminder` templates.

## 3. Receipts, replies and bounces

- `POST /api/v1/webhooks/termii` verifies `X-Termii-Signature` with the configured webhook
  secret (dev adapter: `DEV_SMS_WEBHOOK_SECRET`). Invalid signature → 401. No secret → the event
  is logged as `signature: unchecked` and accepted only outside production (403 in production).
  Outbound receipts update the matching attempt (`delivered`, `failed`, `rejected`); a
  delivered attempt never regresses. Inbound `STOP`/`UNSUBSCRIBE`/... writes opted-out
  `sms_consents` for every category plus an `sms` suppression `stop_keyword`; `START`/`YES`
  records opt-in and lifts the suppression. Every webhook is logged to `integration_logs`
  without the body.
- **SMTP bounces**: no provider webhook is wired yet. Import bounces manually with
  `POST /api/v1/admin/notifications/bounces` (`{ email, kind: hard|soft|complaint, reason }`) or
  enqueue `notifications.process_bounce` with the same payload. Hard bounces and complaints
  suppress the address; soft bounces only mark the attempt.

## 4. Admin

Routes (`apps/web/src/app/api/v1/admin/notifications/**`, OpenAPI in
`apps/web/src/lib/api/registry/notifications.ts`):

- Templates (`notifications.templates.manage`): list/get, create a draft version (next version
  number for key/channel/locale, variables extracted automatically), edit drafts (approved and
  retired versions are immutable), `actions` (`approve` retires older approved versions;
  `retire`; `reopen` a retired version as a draft), `preview` with sample variables (missing
  ones render as `[name]`; SMS previews include segment counts).
- Test send (`notifications.test_send`, no MFA step, 30/hour/user): explicit email or SMS to a
  staff-entered recipient through the active provider. Records an attempt labelled test
  (`relatedEntityType = test_send`), audits `notifications.test_send`, and returns the real
  provider outcome, including negative ones (`provider_not_configured`, rejected numbers).
- Delivery log: `GET .../deliveries` with channel/status/template/recipient/provider/test/date
  filters; cursor paged.
- Provider status: `GET .../providers` (`integrations.read`) reports SMTP and Termii state for
  the current environment from `integration_configs` (`configured`, `status`, last check,
  rotation timestamps, dev fallback) with the last 24 hours of delivery counts. No settings or
  secrets are returned.

## 5. Feed

`GET /api/v1/notifications` (cursor, `unreadOnly`), `POST /api/v1/notifications/{id}/read`,
`POST /api/v1/notifications/read-all`, `GET /api/v1/notifications/unread-count`. All run under
the caller's actor context; rows belong to `user_id = app.user_id()`.

## 6. Templates and seeding

Reference templates are seeded from `packages/db/src/seed/reference.ts` (`notificationTemplates`).
Keys the registry needs beyond that set live in `packages/notifications/src/seed.ts`
(`extraNotificationTemplates`: in-app variants, `lead_created`, `lead_invited`,
`engagement_transitioned`, `task_assigned`, `message_posted`, `work_order`,
`tender_invitation`, `award_published`, `project_status_changed`, `digest`, in-app
`test_message`). Load both sets idempotently with:

```ts
import { ensureNotificationTemplates } from '@simplexd/notifications';
await ensureNotificationTemplates(db); // approved, locale en, version 1; existing rows untouched
```

Run it after `pnpm db:seed` (or from a deploy hook); the test suite calls it in `beforeAll`.

## 7. Tests

`pnpm vitest run --project notifications` (real test database, development adapters). Covers:
three-channel dispatch, replay deduplication, marketing consent, quiet-hour deferral and the
reminder sweep, receipts and STOP/START, missing variables, production without configuration,
labelled test sends, bounce intake, digests, the feed and template lifecycle.
