# Paystack — setup and operating guide

Implementation: `packages/integrations/src/payments/` (provider interface, Paystack adapter, verification matching, webhook planning, development adapter). Accounting postings: `packages/domain/src/ledger/` and [accounting.md](./accounting.md). Build brief: §12, §16, acceptance scenarios 6 and 8.

## 1. What was verified, and what was not

The Paystack documentation site was unreachable from the build environment on 2026-09-23 (egress policy). Everything the adapter relies on was verified from Paystack's **official** open-source repositories (`PaystackOSS/openapi`, `PaystackOSS/doc-code-snippets`, `PaystackOSS/paystack-cli`) and from search-engine snippets of the official pages. Details and provenance per item: [research/paystack-termii-research-2026-09-23.md](./research/paystack-termii-research-2026-09-23.md), Part A.

| Item                                                                                                          | Status                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base URL `https://api.paystack.co`, `Authorization: Bearer <secret key>`, JSON bodies                         | Verified (OpenAPI spec)                                                                                                                                     |
| `POST /transaction/initialize` request/response, integer subunit amounts, `channels` enum, reference charset  | Verified (OpenAPI spec + snippets)                                                                                                                          |
| `GET /transaction/verify/:reference` response shape and statuses `success`, `failed`, `abandoned`, `reversed` | Verified (OpenAPI spec + sample)                                                                                                                            |
| Webhook header `x-paystack-signature` = hex HMAC-SHA512(raw body, secret key)                                 | Verified (official snippets)                                                                                                                                |
| Webhook event names, sample payloads for `charge.success`, `refund.*`, `transfer.*`                           | Verified (official sample files)                                                                                                                            |
| Webhook retries (live: every 3 min ×4 then hourly for 72 h; test: hourly for 10 h)                            | Verified (snippet)                                                                                                                                          |
| Webhook source IPs `52.31.139.75`, `52.49.173.169`, `52.214.14.220`                                           | Verified (snippet)                                                                                                                                          |
| `POST /refund`, `GET /refund/:id`, refund statuses incl. `needs-attention`                                    | Verified (OpenAPI spec + samples)                                                                                                                           |
| Key prefixes `sk_test_` / `sk_live_` / `pk_test_` / `pk_live_`                                                | Verified (snippet)                                                                                                                                          |
| Inline JS v2 `https://js.paystack.co/v2/inline.js`, `resumeTransaction(access_code)`                          | Verified (snippets)                                                                                                                                         |
| Callback query parameter name (`reference`; `trxref` also seen in practice)                                   | `reference` verified; `trxref` **not verified**                                                                                                             |
| Dispute (`charge.dispute.*`) payload                                                                          | Field list verified; the fixture `dispute-create.json` is **reconstructed** from that list, not a verbatim sample; `resolution` vocabulary **not verified** |
| Test card numbers                                                                                             | Captured from search snippets — **re-check the live "Test Payments" page before use**                                                                       |
| Webhook request timeout (reported as 30 s)                                                                    | **Not verified**                                                                                                                                            |

Fixture tests prove the adapter parses the documented shapes. They do **not** prove that live credentials work; only the connection test and a sandbox journey do.

## 2. Admin setup (Admin → Integrations → Payments)

### 2.1 Get keys from the Paystack dashboard

1. Sign in to the Paystack dashboard for the SimplexD business.
2. Go to **Settings → API Keys & Webhooks**.
3. Each mode has its own pair: **Test** keys (`pk_test_…`, `sk_test_…`) and **Live** keys (`pk_live_…`, `sk_live_…`). Live keys only exist once Paystack has approved the business (merchant activation is an external dependency; track it in the launch checklist).
4. Copy the **secret key** into the write-only "Secret key" field and the **public key** into "Public key". The secret is envelope-encrypted at rest (`packages/integrations/src/secrets`); the console shows only a masked prefix and fingerprint afterwards.

The adapter derives the environment from the secret key prefix and refuses to start when the prefix disagrees with the selected environment or with the public key. Test and live credentials, webhook endpoints and data are never mixed.

### 2.2 Save ≠ Test ≠ Activate

The integration exposes the states from brief §16: `disconnected`, `configured-unverified`, `connected`, `degraded`, `expired`, `disabled`.

| Action       | What it does                                                                                                                                                                                                                | Resulting state                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Save**     | Stores the settings and encrypted secret. Nothing is called.                                                                                                                                                                | `configured-unverified`                                                                                  |
| **Test**     | `testConnection()`: one read-only `GET /transaction/verify/<sentinel>` with the saved key. `404 Transaction reference not found` proves the key is accepted; `401 Invalid key` proves it is not. No transaction is created. | `connected` (records "last successful check") or stays `configured-unverified` with the sanitized reason |
| **Activate** | Makes this configuration the one used for new payment attempts; requires a successful test in the same environment and step-up authentication.                                                                              | active                                                                                                   |

"Connected" is never shown merely because a form saved. A key rotation follows the same three steps; the previous configuration stays available for rollback until the new one has passed its verification period.

### 2.3 Webhook URL

Register, **per mode** (test and live are separate settings in the Paystack dashboard):

```
${APP_URL}/api/v1/webhooks/paystack
```

`APP_URL` is the public origin of the deployment (see `.env.example`, `PAYSTACK_WEBHOOK_PATH`). The route:

1. Reads the **raw request body bytes** (no JSON re-serialisation) and the `x-paystack-signature` header.
2. Calls `provider.verifyWebhookSignature(rawBody, header)` — HMAC-SHA512 with the secret key, constant-time comparison, length checked first. Invalid or missing signatures get `401` and are logged without the body.
3. Calls `provider.parseWebhookEvent(rawBody)` and `deriveDedupeKey(event)`; inserts a `provider_events` row (raw body, sanitized headers, `signature_valid=true`, unique `dedupe_key`). A duplicate key means a replay: acknowledge `200` and stop.
4. Returns `200` immediately. Processing happens in the worker queue (`payments.process_provider_event`), which loads the current attempt/refund/chargeback state and runs `planWebhookActions(event, existing)`.

Optional hardening: allow only the three published Paystack IPs at the edge (`PAYSTACK_WEBHOOK_IPS`). The signature check is mandatory regardless.

Paystack retries undelivered events (live: every 3 minutes for 4 tries, then hourly for 72 hours; test: hourly for 10 hours), so replays are normal; the dedupe key makes them harmless.

### 2.4 Enabled channels and payment purposes

`InitializeInput.channels` is sent per transaction from the purposes enabled in the admin form. Valid values (OpenAPI enum): `card`, `bank`, `bank_transfer`, `ussd`, `qr`, `mobile_money`, `eft`, `apple_pay`, `payattitude`, `capitec_pay`. Which channels actually work for the business depends on what Paystack has activated on the merchant account — that is an external setup requirement, not a switch in SimplexD. Recommended default for NGN: `card`, `bank_transfer`, `ussd`.

`currency` must be one of `NGN`, `GHS`, `KES`, `ZAR`, `USD`; the platform uses `NGN` (integer kobo).

### 2.5 Test cards (re-check before use)

Values below came from search snippets of the official "Test Payments" page, which could not be opened directly. **Confirm them on the live page before relying on them.** Expiry can be any future date.

| Scenario                      | Card                    | CVV | PIN  | OTP    |
| ----------------------------- | ----------------------- | --- | ---- | ------ |
| Success, no validation        | 4084 0840 8408 4081     | 408 | —    | —      |
| PIN validation                | 5078 5078 5078 5078 12  | 081 | 1111 | —      |
| PIN + OTP (Verve)             | 5060 6666 6666 6666 666 | 123 | 1234 | 123456 |
| Bank auth simulation          | 5192 6027 2058 4796     | 123 | —    | —      |
| Token not generated (failure) | 4084 0800 0000 5408     | 001 | —    | —      |
| Declined (label not captured) | 4084 0800 0000 0409     | 000 | —    | —      |
| Timeout                       | 5078 5078 5078 5078 53  | —   | —    | —      |
| Insufficient funds            | 5060 6650 6066 5060 67  | —   | —    | —      |

Test bank account (bank channel): Zenith Bank, `0000000000`, any birthday, OTP `123456`. Refund-scenario test cards exist but their numbers were not captured.

## 3. How a payment flows

1. **Create the attempt on the server** from an authorised invoice: immutable `reference` (only `-`, `.`, `=` and alphanumerics), `amountKobo` (bigint), `currency`. Status `initialized`.
2. `provider.initialize(...)` → `POST /transaction/initialize`. Store `authorizationUrl` and `accessCode`; status `pending`. The customer is sent to Paystack's hosted checkout (or the inline popup resumes with the access code). Card details never touch SimplexD.
3. **Callback** (`?reference=`) and **`charge.success` webhook** both lead to the same step: the server calls `provider.verify(reference)` and `matchVerification({ attempt, verification, ageSeconds })`.
   - `settle` only when provider status is `success` **and** reference, amount and currency all equal the attempt. The application then, in one transaction: inserts the allocation with dedupe key `payment_attempt:<id>`, applies `planAllocation`, posts `gatewayPaymentSettled`, issues the receipt and marks the attempt `successful`. A second settle for the same attempt fails on the dedupe key — callback, webhook and retries cannot double-allocate.
   - `mismatch` (different amount — even larger — currency or reference; or a status conflict) never settles; it opens a reconciliation exception.
   - `fail` for `failed`/`abandoned`; `keep_pending` while the provider is still processing; `mark_uncertain` after 24 h with no final answer.
4. **Reconciliation job** (`payments.reconcile_pending`): re-verifies `pending`/`uncertain` attempts, resolves them with the same matcher, and lists exceptions for finance.

A browser redirect is never settlement; visiting the callback only triggers a verify.

## 4. Refunds

- Refunds are separate records: `requested → approved → submitted → pending → settled | failed`. Approval requires **step-up authentication** and an approver different from the requester (application layer).
- On approval the ledger records the liability (`refundApproved`). On submission the app stores an `idempotencyKey` on the refund **before** calling `provider.createRefund` (`POST /refund`); it never calls it twice for the same key. Paystack has no idempotency header, so the key is embedded in `merchant_note` to recognise duplicates in the dashboard, and a timed-out submission is reconciled with `getRefund` before any retry.
- A successful submission is **not** settlement. The refund settles (`refundSettled`, ledger `Dr 2200 / Cr 1100`) only when Paystack reports `processed` — via `refund.processed` webhook or `GET /refund/:id`. `pending`/`processing` keep it pending; `failed` fails it with the reason; `needs-attention` keeps it pending and raises a reconciliation task (Paystack needs the customer's bank details).
- Out-of-order events are handled by `planWebhookActions`: a `refund.pending` arriving after `settled` is ignored as stale; `processed` after `failed` is flagged for a human.

## 5. Chargebacks

`charge.dispute.create` opens a chargeback record, a reconciliation task and the `chargebackOpened` journal (`Dr 2500 / Cr 1100`) without altering the original payment history. Reminders (`charge.dispute.remind`, every 4 hours) surface the evidence deadline. `charge.dispute.resolve` maps `resolution` to won/lost only for unmistakable values (`merchant-accepted`/`auto-accepted` → lost, `declined` → won); anything else is recorded as `unknown` for finance to confirm before `chargebackLost` or `chargebackWon` is posted.

## 6. Development adapter

`DevPaymentProvider` (label: _"development adapter, not a real gateway"_) simulates the same contract in memory: `initialize` returns `${APP_URL}/dev/paystack-checkout?reference=…`, `simulate(reference, outcome)` chooses what `verify` reports (default `pending`), `simulateRefund` drives refund statuses, and `buildWebhookEvent` produces a signed, Paystack-shaped webhook for the local webhook route. It throws when `APP_ENV=production` or when asked for the `live` environment, and `createPaymentProvider` refuses it in production, so a missing Paystack configuration can never silently fall back to a mock.

## 7. Errors shown to people

All provider failures are `ProviderError`s with a code (`auth`, `network`, `invalid_request`, `not_found`, `rate_limited`, `provider_error`). `message` is redacted of secrets and key-like strings and is safe for the admin console and logs; `customerMessage` is the generic text customers see. Raw provider payloads are sanitized (`sanitizeProviderRecord`) before storage: card tokens, signatures, BINs, expiry dates, IPs and logs are removed.

## 8. Launch checklist (external dependencies)

- Paystack merchant approval; live keys issued.
- Test webhook URL and live webhook URL registered (one per mode).
- Channels activated on the merchant account; enabled purposes configured in admin.
- Settlement bank account confirmed in the Paystack dashboard (used by the accountant for `gatewaySettlementToBank`).
- Sandbox journey executed end-to-end with a test key: pay → verify → allocation → receipt; replayed webhook ignored; amount-mismatch case opens an exception; refund processed → settled; dispute → chargeback task.
- Secret rotation rehearsed: save new key → test → activate → confirm the old key never appears in API payloads or logs.
