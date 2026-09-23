# Termii (SMS) — provider setup and operating notes

Adapter: `packages/integrations/src/sms/termii.ts` (`TermiiSmsProvider`), behind the
`SmsProvider` interface in `packages/integrations/src/sms/types.ts`. Development adapter:
`packages/integrations/src/sms/dev.ts`.

Research basis: `docs/providers/research/paystack-termii-research-2026-09-23.md`, PART B. The
official documentation site (`developers.termii.com`) was **unreachable** from the build
environment, so several details were taken from search-engine snippets of the official pages or
from third-party SDKs. Everything listed under [Unverified items](#unverified-items) must be
confirmed against the Termii dashboard and a test send before the live environment is activated.

## 1. Account prerequisites (done by the business owner in the Termii console)

1. Create the Termii account and complete business verification (KYC). Message routes for a
   country are only activated after verification; otherwise sends fail with a "route not set up"
   error.
2. Fund the wallet. The adapter reads the balance on every connection test and every send
   response; a low balance is surfaced in Admin → Integrations → SMS.
3. **Copy the account base URL from the dashboard.** Termii issues account-specific base URLs
   that route to the correct regulatory region. Default `https://v3.api.termii.com`; the legacy
   Nigerian host `https://api.ng.termii.com` still exists for older accounts. Only `https` is
   accepted (Termii answers `Unauthorized` to `http`).
4. Create the API key (dashboard → API settings). It is the only credential; there is no separate
   secret for API calls.
5. Request a sender ID (3–11 letters or digits, e.g. `SimplexD`) with a use case and company
   name. Termii's admin team reviews it manually (typically 1–3 business days); the sender ID
   list shows `pending` until approved. Messages with an unapproved or misspelt sender ID fail
   with `Invalid Sender Id`. The admin screen can submit this request through the adapter
   (`requestSenderId`) and poll the status (`listSenderIds`).
6. Open the webhook configuration page (Events & Reports) and paste the SimplexD webhook URL
   (below). Note which key the page says signs `X-Termii-Signature`; that value goes into the
   "Webhook signing secret" field.

## 2. Admin configuration (Admin → Integrations → SMS)

| Field                    | Stored as                                                  | Notes                                                                                                                                                                              |
| ------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API key                  | secret (envelope-encrypted, write-only, fingerprint shown) | From the dashboard. Never returned to the browser or logged.                                                                                                                       |
| Base URL                 | setting                                                    | Copied from the dashboard. Must be https, credential-free, and its host must match the allow-list (`.termii.com` by default).                                                      |
| Approved sender ID       | setting                                                    | 3–11 alphanumeric. Checked against the account's sender-ID list on every connection test.                                                                                          |
| Environment              | setting                                                    | `test` or `live`. Test and live credentials, webhook origins and data are kept separate.                                                                                           |
| Enabled message purposes | setting                                                    | Only enabled purposes are sent (`booking_confirmation`, `booking_reminder`, `visit_change`, `invoice_due`, `report_ready`, `urgent_decision`, `otp`, `marketing`, `test_message`). |
| Template versions        | setting                                                    | Approved template version per purpose (see `templates` table and `packages/integrations/src/templates`).                                                                           |
| Daily sending limit      | setting                                                    | Messages per day; `0` disables sending.                                                                                                                                            |
| Daily spend cap          | setting                                                    | Kobo per day. Blocks transactional and marketing sends when reached; security messages still go.                                                                                   |
| Unit cost                | setting                                                    | Estimated kobo per segment for previews and spend accounting.                                                                                                                      |
| Delivery reports         | setting                                                    | Webhook path and a polling fallback interval.                                                                                                                                      |
| Webhook signing secret   | secret                                                     | Value Termii signs `X-Termii-Signature` with (see unverified items).                                                                                                               |
| Test recipient           | setting                                                    | E.164 number that receives test messages. Always displayed before a test send.                                                                                                     |

Schemas: `termiiConfigSchema` (adapter input, includes secrets) and `termiiSettingsSchema`
(non-secret admin settings) in `packages/integrations/src/sms`. Field descriptors for the form:
`TERMII_ADMIN_FIELDS`.

### Save, test and activate are three different actions

- **Save** stores settings and secrets. It does not contact Termii. The integration state becomes
  `configured_unverified`.
- **Test** (`testConnection()`) authenticates with `GET /api/get-balance`, then reads the sender-ID
  list and checks the configured sender ID. The result is `ok` only when the key authenticates
  **and** the sender ID is registered and approved. The state becomes `connected` on success,
  `degraded` when authentication works but the sender ID is pending/blocked/unregistered, and
  stays `configured_unverified` on authentication failure. The last check time and sanitised
  message are stored.
- **Activate** makes this configuration version the active one for its environment. Activation
  requires a successful test and step-up authentication.

"Connected" is never shown merely because a form saved.

## 3. Endpoints used

All requests are JSON. The API key is sent in the JSON body for POST and as the `api_key` query
parameter for GET; there is no `Authorization` header.

| Purpose           | Request                                                                            | Notes                                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Send one          | `POST {BASE}/api/sms/send` `{api_key,to,from,sms,type:"plain",channel}`            | `to` is digits only (`2348012345678`). Success: `{code:"ok", message_id, message, balance, user}`. `message_id` is a 64-bit integer and is parsed as a **string**. |
| Send bulk         | `POST {BASE}/api/sms/send/bulk` with `to: [...]`                                   | Chunked at 100 recipients per request. One `message_id` per chunk.                                                                                                 |
| Balance           | `GET {BASE}/api/get-balance?api_key=`                                              | `{balance, currency, user}`.                                                                                                                                       |
| Sender IDs        | `GET {BASE}/api/sender-id?api_key=`                                                | Paginated `{data:[{sender_id,status,company,usecase,country,created_at}]}`.                                                                                        |
| Request sender ID | `POST {BASE}/api/sender-id/request` `{api_key,sender_id,use_case,usecase,company}` | Both `use_case` and `usecase` are sent because the docs disagree.                                                                                                  |
| Message status    | `GET {BASE}/api/sms/inbox?api_key=&message_id=`                                    | Polling fallback for messages without a receipt.                                                                                                                   |
| OTP (optional)    | `POST {BASE}/api/sms/otp/send`, `POST {BASE}/api/sms/otp/verify`                   | Termii-managed OTP; not used for staff MFA.                                                                                                                        |

Timeouts: 10 s per request (configurable 1–60 s). HTTP 429 and 5xx, network errors and timeouts
are reported as `retryable: true` for the worker queue; 4xx are not.

## 4. Channels: DND vs generic vs WhatsApp

- `dnd` (transactional route): reaches numbers on the Do-Not-Disturb register. Used by default
  for `transactional` and `security` categories (booking confirmations, invoice notices, OTPs).
- `generic` (promotional route): does **not** deliver to DND numbers and is subject to a time
  restriction for MTN numbers in Nigeria (no delivery between 20:00 and 08:00 WAT). Used by
  default for `marketing`. Quiet hours in the send policy default to that window.
- `whatsapp`: requires a connected WhatsApp device on the Termii account; optional.

The caller can override the channel per message (`channel` on `SmsSendInput`).

## 5. Costs and segments

`analyzeSegments(body)` implements GSM 03.38: messages made only of GSM-7 characters cost 160
characters per single message and 153 per part when concatenated; any other character (curly
quotes, emoji, many accented letters) switches the whole message to UCS-2 at 70/67. GSM
extension characters (`^ { } \ [ ~ ] | €`) count double. `estimateCost({segments, unitCostKobo,
recipients})` multiplies by the configured unit cost. The worker records `segments` and
`estimated_cost_kobo` on each `delivery_attempts` row and adds the estimate to the daily spend
counter checked by `evaluateSendPolicy`.

Termii bills per segment per destination network; the exact NGN price per segment is
account-specific (set the unit cost from the dashboard price list). While editing an SMS template
in _Admin → Communications → Templates_ the preview shows the encoding (GSM-7 or Unicode, with the
characters that forced Unicode), the segment count, the units left in the current segment and the
estimated cost per recipient at the active configuration's `unitCostKobo` (the default ₦4.00 per
segment is labelled as such until a Termii configuration sets the price). Bodies over five
segments are refused.

## 6. Consent, categories, opt-out and quiet hours

`evaluateSendPolicy` (pure) is called by the worker before every send with facts loaded from
`sms_consents`, `suppressions`, `notification_preferences` and the day's spend:

- `suppressed` (any entry in `suppressions` for the number) or a disabled purpose blocks every
  category, including security.
- `security` (OTP, sign-in alerts) otherwise always sends; no quiet hours, no spend cap.
- `transactional` sends unless the person explicitly opted out of transactional SMS; it counts
  against the spend cap.
- `marketing` requires an explicit `opted_in` record; it respects quiet hours by returning
  `deferUntil` (the worker re-queues the job for that time) and counts against the spend cap.

Opt-out replies: inbound webhooks carry the reply text. `classifyInboundKeyword` recognises
STOP/UNSUBSCRIBE/CANCEL/END/QUIT (opt-out) and START/UNSTOP/SUBSCRIBE/YES (opt-in). An opt-out
writes an `opted_out` consent record for marketing **and** a `suppressions` row, so it applies
across all campaigns. Whether Termii forwards inbound replies to alphanumeric sender IDs is
account/route dependent (see unverified items); the customer portal's notification preferences
remain the primary opt-out path.

Transactional messages carry minimal private information and link to authenticated content
(the seed templates use `{{manageUrl}}`, `{{invoiceUrl}}`, `{{reportUrl}}` links; amounts and
names are kept to what the customer already knows).

**Verified numbers only.** The pipeline sends SMS only to a profile number that its owner
confirmed with a one-time code (`user_profiles.phone_verified_at`). Any other number — a changed
profile number, or one typed into a public booking or lead form — records a `suppressed` attempt
with reason `phone_unverified` and the email/in-app channels still go out. The only exceptions are
the verification code itself and explicit staff test sends, which set `allowUnverifiedPhone` on
the request. This closes the SMS-pumping and harassment vector of free-text phone fields.

## 7. Delivery reports

Webhook URL to paste into the Termii console:

```
${APP_URL}/api/v1/webhooks/termii
```

One account-wide URL; Termii POSTs JSON with the header `X-Termii-Signature` = HMAC-SHA512 of the
raw request body, signed with the account secret. The route must:

1. read the **raw** body (no re-serialisation),
2. call `provider.parseDeliveryWebhook(rawBody, headers)` and reject with 401 unless
   `signature === 'valid'` (in production a missing webhook secret is a configuration error;
   `unchecked` must not be accepted),
3. durably record the event keyed by `providerMessageId` before responding `200`,
4. update `delivery_attempts` by `provider_message_id`: `delivered` sets `delivered_at`; `failed`,
   `rejected` and `expired` set `failed_at`; `sent` is an intermediate carrier acknowledgement.

Event types: `outbound` (delivery report), `inbound` (reply), `device_status` (WhatsApp device
online/offline). Unknown shapes are recorded as `unknown` and ignored.

Status mapping (`mapTermiiStatus`, case-insensitive, prefix/keyword based):

| Provider status (examples)                               | Delivery state |
| -------------------------------------------------------- | -------------- |
| `DELIVERED \| Message delivered to handset`, `Delivered` | `delivered`    |
| `DND Active on Phone Number`, `Rejected`                 | `rejected`     |
| `Message Failed`, `Failed`, `Undelivered`                | `failed`       |
| `Expired`                                                | `expired`      |
| `Message Sent`, `Sent`                                   | `sent`         |
| anything else                                            | `unknown`      |

**Accepted is not delivered.** A `2xx` with a `message_id` only means Termii queued the message
(`delivery_attempts.status = accepted`). Delivery is shown only after a receipt or a status poll
says so. Messages still `accepted` after the configured polling delay are checked with
`getMessageStatus` by the worker. Provider ids and sanitised errors are always kept on the
attempt row.

## 8. OTP

SimplexD generates and verifies its own codes (`packages/integrations/src/sms/otp.ts`):
random numeric codes, scrypt-hashed storage in `otp_challenges.code_hash`
(`scrypt$salt$hash`), expiry (default 10 minutes), attempt limit (default 5), constant-time
comparison. The plaintext code exists only long enough to render the `otp` template and is never
logged, never stored and never included in job payloads that are logged.

Termii's Token API (`sendProviderOtp` / `verifyProviderOtp`) is implemented but optional and
**not** used for staff MFA. Staff MFA prefers authenticator apps; SMS is never the only
protection for a privileged account.

**Phone verification (portal).** Customers verify the number saved on their profile from
_Portal → Settings → Profile → Verify your phone number_ (`apps/web/src/server/portal/phone-verification.ts`,
`POST /api/v1/me/phone/verification` then `POST …/confirm`):

- a 6-digit code goes out as the `otp` template (`security` category, `allowUnverifiedPhone`),
  recorded as a `delivery_attempts` row with `related_entity_type = otp_challenge` and no body;
- `otp_challenges` keeps `scrypt$salt$hash`, the expiry (10 minutes), the attempt counter (5) and
  `consumed_at`; requesting a new code supersedes the previous one;
- limits, enforced from the challenge rows (not from memory): one request per 60 s, 5 per user
  per hour, 5 per number per hour, 10 per number per day (429 with `Retry-After`);
- wrong codes count even though the request fails; the fifth locks the code; expired, superseded
  and locked codes need a new request; a changed number invalidates the code;
- a number that replied STOP is refused with a clear message (the suppression is honoured even
  for security messages); a provider rejection is reported honestly and the code is consumed;
- success sets `phone_verified_at`, audits `profile.phone_verified` (masked number, never the
  code) and unlocks SMS preferences;
- with the development adapter the response is labelled “Development adapter — no real message
  was sent” and, in `APP_ENV=development|test` only, carries the code so the flow can be
  completed locally. A real adapter never returns the code.

## 9. Test sends

_Admin → Communications → Test send_ (`notifications.test_send`, no MFA step, 30 per hour per
user) sends one SMS or email to the address the operator types; the recipient is shown before
sending and echoed in the result, and nothing goes to customers. Any template can be chosen and
renders with the same sample values the preview uses (never customer data). The result has two
separate parts: the provider's own answer (accepted, or rejected with the sanitised reason and
provider message id, plus which adapter handled it — the development adapter is labelled “no real
message was sent”), and the delivery status, which only a Termii receipt changes. The attempt is
recorded in the delivery log with `related_entity_type = test_send`, audited as
`notifications.test_send`, and can be refreshed from the page. With the development adapter the
page can also feed a signed simulated receipt (“delivered” / “failed”) through the real webhook
handler to show the accepted → delivered distinction.

## 10. Failure handling

- Sends run from the worker queue with retry/backoff and bounded attempts; `retryable` on the
  result tells the queue whether to retry. Exhausted jobs go to the dead-letter queue for admin
  retry.
- An SMS failure never reverses a completed business transaction (a paid invoice stays paid; a
  confirmed booking stays confirmed). The failure is visible on the record's activity log.
- Every error string is sanitised: the API key and webhook secret are stripped from any echoed
  text, control characters are removed and the text is truncated. The adapter never logs.
- Typical errors: `Unauthorized` → wrong key, wrong base URL or `http`; `Invalid Sender Id` →
  sender ID not approved or misspelt; "route not set up" → country route inactive, contact the
  account manager; daily device limit (WhatsApp).

## 11. Development

Without a Termii API key the labelled development adapter (`DevSmsProvider`) is used
automatically (it refuses to start in production). It keeps messages in memory, generates
deterministic message ids per idempotency key, and can simulate signed delivery receipts and
inbound replies (`simulateDeliveryReceipt`, `simulateInbound`) to exercise the webhook route.
Numbers ending in `0000` are rejected at send time, `1111` fail after acceptance and `2222` are
rejected as DND. The delivery log and test-send page label every attempt the development adapter
handled, and `POST /api/v1/admin/notifications/deliveries/{id}/simulate-receipt` (404 in
production) runs a simulated receipt through the webhook route.

## Unverified items

Confirm each of these against the Termii dashboard or a sandbox send before go-live:

1. Which host is current for this account (`v3.api.termii.com` vs `api.ng.termii.com`): read it
   from the dashboard.
2. Which secret signs `X-Termii-Signature` (community SDKs use the API key; the docs say "your
   secret key"). The adapter keeps it as a separate "webhook signing secret" field; if the
   dashboard shows no dedicated secret, paste the API key there.
3. Signature encoding (hex is expected; base64 is accepted as a fallback).
4. The outbound delivery-report payload shape (the fixture used comes from a third-party SDK's
   captured payload) and the timezone of `sent_at` values without a zone (assumed
   `Africa/Lagos`, configurable via `webhookTimeZone`).
5. Bulk request recipient limit (100 assumed; a blog post mentions up to 10k).
6. `type: "unicode"` for non-GSM messages (only `plain` is verified). The adapter sends `plain`
   unless `messageType: 'unicode'` is requested.
7. Error response JSON shape and rate limits (not published; retry on 429/5xx with backoff).
8. Whether inbound replies (STOP) are delivered to webhooks for alphanumeric sender IDs.
9. Sender-ID request response body and the exact `use_case`/`usecase` field name.
10. Webhook retry policy and expected response (respond `200` quickly).
