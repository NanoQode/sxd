# Paystack + Termii — provider API research (2026-09-23)

## 0. Access status and how each item was verified

The network egress proxy in this session **blocks the official documentation hosts outright** (CONNECT 403 / `EGRESS_BLOCKED`). Per the proxy README, a 403 is an org policy denial and must not be routed around, so no cache/reader proxies were used. Blocked on 2026-09-23 (each tried explicitly):

| URL                                                                                                                                | Result                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| https://paystack.com/docs/payments/accept-payments/                                                                                | BLOCKED (egress policy, domain `paystack.com`)                                   |
| https://paystack.com/docs/payments/verify-payments/                                                                                | BLOCKED                                                                          |
| https://paystack.com/docs/payments/webhooks/                                                                                       | BLOCKED                                                                          |
| https://paystack.com/docs/api/transaction/                                                                                         | BLOCKED                                                                          |
| https://paystack.com/docs/api/refund/                                                                                              | BLOCKED                                                                          |
| https://paystack.com/docs/payments/test-payments/                                                                                  | BLOCKED (page exists; title "Test Payments \| Paystack Developer Documentation") |
| https://docs-v1.paystack.com/…, https://support.paystack.com/…, https://changelog.paystack.com/…, https://developers.paystack.co/… | BLOCKED (all Paystack subdomains / old docs domain)                              |
| https://developers.termii.com/ and /messaging (+ every sub-page)                                                                   | BLOCKED (domain `developers.termii.com`)                                         |
| https://developer.termii.com/ (singular alias)                                                                                     | BLOCKED                                                                          |
| https://blog.termii.com/…, https://termii.medium.com/…, https://termii.com/                                                        | BLOCKED                                                                          |
| https://web.archive.org/…                                                                                                          | not fetchable by the tool                                                        |
| https://apis.io/…, https://jentic.com/… (third-party OpenAPI mirrors)                                                              | BLOCKED                                                                          |
| https://www.npmjs.com/package/@paystack/inline-js                                                                                  | 403                                                                              |

What **was** reachable and is used as evidence:

- **github.com / raw.githubusercontent.com** — Paystack's official open-source org **PaystackOSS** (contact `techsupport@paystack.com` in the spec):
  - `PaystackOSS/openapi` → `dist/paystack.yaml` (520 KB, OpenAPI 3.0.1, "The OpenAPI specification for the Paystack API"). Downloaded 2026-09-23.
  - `PaystackOSS/doc-code-snippets` — "A repo to host the code snippets on the Paystack developer documentation … so code management processes can be put in place". Cloned 2026-09-23, HEAD `a6bdd4b` dated **2026-09-22**. Every snippet below marked `[OFFICIAL-GH]` is copied verbatim from these two repos.
  - `PaystackOSS/paystack-cli` `lib/paystack/webhooks.js` (sample events).
- **registry.npmjs.org** (direct, no proxy) — `@paystack/inline-js` metadata: latest **2.25.0** published 2026-09-08, repo `github.com/PaystackHQ/inline-js` (README not included in the registry document).
- **WebSearch restricted to the official domains** (`allowed_domains: paystack.com` / `developers.termii.com`). The search engine returns text snippets of the blocked pages; items marked `[OFFICIAL-SNIPPET]` come from those snippets. They are short quotations, not full-page reads.
- **Third-party mirrors** (marked `[THIRD-PARTY]`, use with caution): `api-evangelist/termii` (OpenAPI/Postman derived from developers.termii.com, snapshot 2026-06-20 to 2026-09-21), SDK repos `Mane-Olawale/termii` (PHP, real captured webhook fixtures), `ekunemmanuel/termii` (TS, Zod webhook schemas), `brvhprince/termii-js` (npm README), `zeevx/lara-termii`, `Douglasokolaa/termii-php`, GitHub code search statistics.

Legend used per item:

- **Verified from official docs on 2026-09-23 [OFFICIAL-GH]** — from Paystack's official GitHub sources above.
- **Verified from official docs on 2026-09-23 [OFFICIAL-SNIPPET]** — from search-engine snippets of the official docs page (page fetch blocked).
- **NOT VERIFIED (fetch blocked)** — only third-party/community evidence or memory; treat as "confirm before relying on it".

---

# PART A — Paystack

## A.1 Base URL, auth, content type

- Base URL: **`https://api.paystack.co`** — Verified from official docs on 2026-09-23 [OFFICIAL-GH] (`dist/paystack.yaml` → `servers: - url: https://api.paystack.co  description: Base API endpoint`; every curl snippet in doc-code-snippets uses it).
- Auth: HTTP Bearer with the **secret key** — Verified [OFFICIAL-GH]:

```yaml
# dist/paystack.yaml (components.securitySchemes)
securitySchemes:
  bearerAuth:
    type: http
    scheme: bearer
    description: Secret key in the format sk_domain_xxxxxx
```

Header exactly as used in the docs' snippets: `Authorization: Bearer YOUR_SECRET_KEY` (some snippets use lowercase `authorization:`; HTTP header names are case-insensitive). `Content-Type: application/json`. The spec also declares `application/x-www-form-urlencoded` as an accepted request body type for initialize/refund.

- Key prefixes — Verified [OFFICIAL-SNIPPET] (support article "Test Mode and Live Mode", search snippet): _"Each environment has its own set of public and secret keys, with test keys prefixed with `pk_test_` and `sk_test_`, while live keys are prefixed with `pk_live_` and `sk_live_`."_ Test keys: Dashboard → **Settings → API Keys & Webhooks** (snippet: _"go to your Dashboard Settings page and click the API Keys & Webhooks tab to get your Test API Keys"_).
- Unauthorized (401) body — Verified [OFFICIAL-GH] (`components.responses.Unauthorized` example):

```json
{ "status": false, "message": "Invalid key" }
```

- Generic error model — Verified [OFFICIAL-GH]: `{ status: boolean, message: string, meta: { nextStep: string }, type: "validation_error"|"processor_error"|"api_error", code: string, errorCodeMappingNotFound: boolean }`.

## A.2 POST /transaction/initialize

Verified from official docs on 2026-09-23 [OFFICIAL-GH] — `dist/paystack.yaml` path `/transaction/initialize` (`operationId: transaction_initialize`, "Create a new transaction"), request schema `TransactionInitialize`:

```yaml
TransactionInitialize:
  description: Initialize a transaction
  type: object
  required:
    - email
    - amount
  properties:
    email:
      description: Customer's email address
      type: string
    amount:
      description: |
        Amount should be in smallest denomination of the currency.
      type: integer
    currency:
      $ref: '#/components/schemas/Currency' # enum: GHS, KES, NGN, ZAR, USD
    reference:
      description: Unique transaction reference. Only -, ., = and alphanumeric characters allowed.
      type: string
    channels:
      description: An array of payment channels to control what channels you want to make available to the user to make a payment with
      type: array
      items:
        type: string
        enum:
          - apple_pay
          - bank
          - bank_transfer
          - capitec_pay
          - card
          - eft
          - mobile_money
          - payattitude
          - qr
          - ussd
    callback_url:
      description: |
        Fully qualified url, e.g. https://example.com/ to redirect your customers to after a successful payment. Use this to override the callback url provided on the dashboard for this transaction
      type: string
    plan:
      description: |
        If transaction is to create a subscription to a predefined plan, provide plan code here.
        This would invalidate the value provided in amount
      type: string
    invoice_limit:
      description: Number of times to charge customer during subscription to plan
      type: integer
    split_code:
      description: The split code of the transaction split
      type: string
    split:
      $ref: '#/components/schemas/SplitCreate'
    subaccount:
      description: The code for the subaccount that owns the payment
      type: string
    transaction_charge:
      description: |
        A flat fee to charge the subaccount for a transaction.
        This overrides the split percentage set when the subaccount was created
      type: string
    bearer:
      description: The bearer of the transaction charge
      type: string
      enum: [account, subaccount]
    label:
      description: Used to replace the email address shown on the Checkout
      type: string
    metadata:
      description: JSON object of custom data
      type: object
  example:
    email: test@demo.com
    amount: 10000
```

Currency enum (schema `Currency`, "List of all support currencies"): **GHS, KES, NGN, ZAR, USD** [OFFICIAL-GH].

Docs request snippet (doc-code-snippets `src/doc/payments/accept-payment/initialize-transaction/index.sh`) [OFFICIAL-GH]:

```sh
curl https://api.paystack.co/transaction/initialize
-H "Authorization: Bearer YOUR_SECRET_KEY"
-H "Content-Type: application/json"
-d '{ "email": "customer@email.com",
      "amount": "500000"
    }'
-X POST
```

Node snippet with `callback_url` + `metadata.cancel_action` (`src/doc/payments/accept-payment/redirect-backend/index.js`) [OFFICIAL-GH]:

```js
const params = JSON.stringify({
  email: 'customer@email.com',
  amount: '20000',
  callback_url: 'https://hello.pstk.xyz/callback',
  metadata: { cancel_action: 'https://your-cancel-url.com' },
});
// POST https://api.paystack.co/transaction/initialize
// headers: { Authorization: 'Bearer SECRET_KEY', 'Content-Type': 'application/json' }
```

Response (doc snippet `initialize-transaction/index.json`) [OFFICIAL-GH]:

```json
{
  "status": true,
  "message": "Authorization URL created",
  "data": {
    "authorization_url": "https://checkout.paystack.com/nkdks46nymizns7",
    "access_code": "nkdks46nymizns7",
    "reference": "nms6uvr1pl"
  }
}
```

Response schema `TransactionInitializeResponse` requires `status`, `message`, `data{authorization_url, access_code, reference}` (all required strings) [OFFICIAL-GH].

400 example (`TransactionInitializeBadRequestModel`) [OFFICIAL-GH]:

```json
{
  "status": false,
  "message": "Duplicate Transaction Reference",
  "meta": { "nextStep": "Try and create the Transaction or Charge with a new reference" },
  "type": "validation_error",
  "code": "duplicate_reference",
  "errorCodeMappingNotFound": false
}
```

Metadata `custom_fields` format (`src/doc/payments/metadata/custom-fields/index.json`) [OFFICIAL-GH]:

```json
{
  "metadata": {
    "cart_id": 398,
    "custom_fields": [
      { "display_name": "Invoice ID", "variable_name": "Invoice ID", "value": 209 },
      {
        "display_name": "Cart Items",
        "variable_name": "cart_items",
        "value": "3 bananas, 12 mangoes"
      }
    ]
  }
}
```

(`metadata.custom_filters` also exists: `{"recurring": true, "banks": ["057","100"], "card_brands": ["visa"]}` [OFFICIAL-GH].)

### Amount as integer subunit

- Verified [OFFICIAL-GH]: OpenAPI `amount: integer — "Amount should be in smallest denomination of the currency."`; Popup snippet comment: _"the amount value is multiplied by 100 to convert to the lowest currency unit"_.
- Verified [OFFICIAL-SNIPPET] (accept-payments page): _"The amount should be in the subunit of the supported currency. Sending an amount in subunits simply means multiplying the base amount by 100. For example, if a customer is supposed to make a payment of NGN 100, you would send 10000 = 100 * 100 in your request."_ and _"For NGN payments, this means you should send the kobo equivalent."_
- Note: the docs' own curl snippets pass `"amount": "500000"` as a **string**; the API accepts numeric strings, but the schema type is integer — send an integer (kobo/pesewas/cents) from the adapter.

### Redirect / callback

- Verified [OFFICIAL-SNIPPET] (verify-payments page): _"When a transaction is successful, Paystack will redirect the user back to a callback_url you set, with the transaction reference appended in the URL … the user will be redirected to `http://your_website.com/postpayment_callback.php?reference=YOUR_REFERENCE`."_ and _"just because the callback_url was visited doesn't prove that the transaction was successful"_ — always call verify.
- NOT VERIFIED (fetch blocked): in practice Paystack appends both `trxref` and `reference` query params; only `reference` is confirmed by the official snippet. Read `reference`, fall back to `trxref`.

## A.3 GET /transaction/verify/:reference

Verified [OFFICIAL-GH] — path `/transaction/verify/{reference}` (`operationId: transaction_verify`, "Verify a previously initiated transaction using it's reference"; path param `reference` required, example `re4lyvq3s3`; responses 200 `VerifyResponse`, 401, 404 `{ "status": false, "message": "Entity not found" }` generic example).

Docs snippet (`src/doc/payments/verify-payment/verify/index.sh`) [OFFICIAL-GH]:

```sh
curl https://api.paystack.co/transaction/verify/:reference
-H "Authorization: Bearer YOUR_SECRET_KEY"
-X GET
```

Full sample response (`src/doc/payments/verify-payment/verify/index.json`) [OFFICIAL-GH]:

```json
{
  "status": true,
  "message": "Verification successful",
  "data": {
    "id": 4099260516,
    "domain": "test",
    "status": "success",
    "reference": "re4lyvq3s3",
    "receipt_number": null,
    "amount": 40333,
    "message": null,
    "gateway_response": "Successful",
    "paid_at": "2024-08-22T09:15:02.000Z",
    "created_at": "2024-08-22T09:14:24.000Z",
    "channel": "card",
    "currency": "NGN",
    "ip_address": "197.210.54.33",
    "metadata": "",
    "log": {
      "start_time": 1724318098,
      "time_spent": 4,
      "attempts": 1,
      "errors": 0,
      "success": true,
      "mobile": false,
      "input": [],
      "history": [
        { "type": "action", "message": "Attempted to pay with card", "time": 3 },
        { "type": "success", "message": "Successfully paid with card", "time": 4 }
      ]
    },
    "fees": 10283,
    "fees_split": null,
    "authorization": {
      "authorization_code": "AUTH_uh8bcl3zbn",
      "bin": "408408",
      "last4": "4081",
      "exp_month": "12",
      "exp_year": "2030",
      "channel": "card",
      "card_type": "visa ",
      "bank": "TEST BANK",
      "country_code": "NG",
      "brand": "visa",
      "reusable": true,
      "signature": "SIG_yEXu7dLBeqG0kU7g95Ke",
      "account_name": null
    },
    "customer": {
      "id": 181873746,
      "first_name": null,
      "last_name": null,
      "email": "demo@test.com",
      "customer_code": "CUS_1rkzaqsv4rrhqo6",
      "phone": null,
      "metadata": null,
      "risk_action": "default",
      "international_format_phone": null
    },
    "plan": null,
    "split": {},
    "order_id": null,
    "paidAt": "2024-08-22T09:15:02.000Z",
    "createdAt": "2024-08-22T09:14:24.000Z",
    "requested_amount": 30050,
    "pos_transaction_data": null,
    "source": null,
    "fees_breakdown": null,
    "connect": null,
    "transaction_date": "2024-08-22T09:14:24.000Z",
    "plan_object": {},
    "subaccount": {}
  }
}
```

Field types from `VerifyResponse` schema [OFFICIAL-GH]: `data.id` integer; `data.status` string (transaction statuses used elsewhere in the spec: `success`, `failed`, `abandoned`, `reversed`); `reference` string; `amount` integer (subunit); `currency` string; `gateway_response` string; `paid_at` string|null; `channel` string; `customer` object (`id, first_name, last_name, email, customer_code, phone, metadata, risk_action, international_format_phone`); `fees` integer|null; `metadata` string|object; `log` object|null; `requested_amount` integer; `authorization` object (`authorization_code, bin, last4, exp_month, exp_year, channel, card_type, bank, country_code, brand, reusable, signature, …`).

Verification guidance — Verified [OFFICIAL-SNIPPET]: _"The API response has a status key indicating the status of the API call, but the actual transaction status is in the data object as `response.data.status`"_; _"It's very important that you call the Verify endpoint to confirm transaction status before delivering value."_ Adapter rule: `status === true && data.status === "success"` **and** `data.amount`/`data.currency` equal what you initialized (amount check is standard practice; the exact docs sentence about amount was not captured in a snippet).

## A.4 Webhooks

- Header: **`x-paystack-signature`** — Verified [OFFICIAL-GH] (snippets below) and [OFFICIAL-SNIPPET]: _"Valid events are raised with a header X-Paystack-Signature which is essentially a HMAC SHA512 signature of the event payload, signed using your secret key."_
- Algorithm: HMAC-SHA512 over the **raw request body bytes**, key = your **secret key** (`sk_…`), hex digest, compared to the header. Official snippets (doc-code-snippets `src/doc/payments/webhooks/verifying-transaction/`) [OFFICIAL-GH]:

```js
const crypto = require('crypto');
const secret = process.env.SECRET_KEY;
// Using Express
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.post('/my/webhook/url', function (req, res) {
  //validate event
  const hash = crypto.createHmac('sha512', secret).update(req.rawBody).digest('hex');
  if (hash == req.headers['x-paystack-signature']) {
    // Retrieve the request's body
    const event = req.body;
    // Do something with event
  }
  res.send(200);
});
```

```php
<?php
  // only a post with paystack signature header gets our attention
  if ((strtoupper($_SERVER['REQUEST_METHOD']) != 'POST' ) || !array_key_exists('HTTP_X_PAYSTACK_SIGNATURE', $_SERVER) )
      exit();

  // Retrieve the request's body
  $input = @file_get_contents("php://input");
  define('PAYSTACK_SECRET_KEY','SECRET_KEY');

  // validate event do all at once to avoid timing attack
  if($_SERVER['HTTP_X_PAYSTACK_SIGNATURE'] !== hash_hmac('sha512', $input, PAYSTACK_SECRET_KEY))
      exit();

  http_response_code(200);

  // parse event (which is json string) as object
  // Do something - that will not take long - with $event
  $event = json_decode($input);

  exit();
?>
```

- Expected response: **HTTP 200 OK**, quickly — Verified [OFFICIAL-SNIPPET]: _"If we don't get a 200 OK HTTP response from your webhooks, we flagged it as a failed attempt."_ / _"Acknowledging an event means returning a 200 OK in the HTTP header."_ / _"If you have extra tasks in your webhook function, you should return a 200 OK response immediately. Long-running tasks lead to a request timeout and an automatic error response from your server."_ Request timeout is reported as **30 seconds** (search summary; wording not captured verbatim → treat as NOT VERIFIED).
- Retries — Verified [OFFICIAL-SNIPPET] (webhooks page, exact phrase search): _"In the live mode, failed attempts are retried every 3 minutes for the first 4 tries, then retried hourly for the next 72 hours · In the test mode, failed attempts are retried hourly for the next 10 hours."_ (One earlier, less exact snippet said "72 hours" for test mode; the exact-phrase result says 10 hours.)
- IP allowlist — Verified [OFFICIAL-SNIPPET] (webhooks page): **`52.31.139.75`, `52.49.173.169`, `52.214.14.220`** — _"You should whitelist these IP addresses and consider requests from other IP addresses a counterfeit"_; applicable to both test and live. (Unrelated: the dashboard "IP whitelisting" feature restricts which IPs may _call the API with your keys_, up to 10 IPv4 per environment.)
- Configuration: webhook URL is set per environment on Dashboard → Settings → **API Keys & Webhooks** [OFFICIAL-SNIPPET]. Payload envelope is always `{ "event": "<name>", "data": { … } }` [OFFICIAL-GH].
- Event names — Verified [OFFICIAL-GH] from the sample-event files that back the docs (`src/doc/payments/webhooks/events/*.json` and related), enumerated by grepping `"event"` values:

  | Event                                                                                                  | Sample file / notes                                                                                                                                                                           |
  | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `charge.success`                                                                                       | `transaction-successful.json` (sample below)                                                                                                                                                  |
  | `charge.dispute.create`, `charge.dispute.remind`, `charge.dispute.resolve`                             | dispute samples; [OFFICIAL-SNIPPET]: _"charge.dispute.create when a dispute is logged, charge.dispute.remind every 4 hours for unresolved chargebacks, charge.dispute.resolve once resolved"_ |
  | `customeridentification.success`, `customeridentification.failed`                                      | identity samples                                                                                                                                                                              |
  | `dedicatedaccount.assign.success`, `dedicatedaccount.assign.failed`                                    | DVA samples                                                                                                                                                                                   |
  | `invoice.create`, `invoice.update`, `invoice.payment_failed`                                           | subscription invoices                                                                                                                                                                         |
  | `paymentrequest.pending`, `paymentrequest.success`                                                     | payment requests / terminal                                                                                                                                                                   |
  | `refund.pending`, `refund.processing`, `refund.processed`, `refund.failed`, `refund.needs-attention`   | refund samples (below)                                                                                                                                                                        |
  | `subscription.create`, `subscription.disable`, `subscription.not_renew`, `subscription.expiring_cards` | subscription samples                                                                                                                                                                          |
  | `transfer.success`, `transfer.failed`, `transfer.reversed`                                             | transfer samples                                                                                                                                                                              |
  | `bank.transfer.rejected`                                                                               | virtual-terminal doc sample                                                                                                                                                                   |

  The docs page states the list grows ("We would add more to this list as we hook into more actions in the future") [OFFICIAL-SNIPPET].

`charge.success` sample (`transaction-successful.json`) [OFFICIAL-GH]:

```json
{
  "event": "charge.success",
  "data": {
    "id": 302961,
    "domain": "live",
    "status": "success",
    "reference": "qTPrJoy9Bx",
    "amount": 10000,
    "message": null,
    "gateway_response": "Approved by Financial Institution",
    "paid_at": "2016-09-30T21:10:19.000Z",
    "created_at": "2016-09-30T21:09:56.000Z",
    "channel": "card",
    "currency": "NGN",
    "ip_address": "41.242.49.37",
    "metadata": 0,
    "log": {
      "time_spent": 16,
      "attempts": 1,
      "authentication": "pin",
      "errors": 0,
      "success": false,
      "mobile": false,
      "input": [],
      "channel": null,
      "history": [
        {
          "type": "input",
          "message": "Filled these fields: card number, card expiry, card cvv",
          "time": 15
        },
        { "type": "action", "message": "Attempted to pay", "time": 15 },
        { "type": "auth", "message": "Authentication Required: pin", "time": 16 }
      ]
    },
    "fees": null,
    "customer": {
      "id": 68324,
      "first_name": "BoJack",
      "last_name": "Horseman",
      "email": "bojack@horseman.com",
      "customer_code": "CUS_qo38as2hpsgk2r0",
      "phone": null,
      "metadata": null,
      "risk_action": "default"
    },
    "authorization": {
      "authorization_code": "AUTH_f5rnfq9p",
      "bin": "539999",
      "last4": "8877",
      "exp_month": "08",
      "exp_year": "2020",
      "card_type": "mastercard DEBIT",
      "bank": "Guaranty Trust Bank",
      "country_code": "NG",
      "brand": "mastercard",
      "account_name": "BoJack Horseman"
    },
    "plan": {}
  }
}
```

Refund events (`refund-pending.json`, `refund-processed.json`, `refund-failed.json`, `refund-needs-attention.json`) [OFFICIAL-GH]:

```json
{
  "event": "refund.pending",
  "data": {
    "status": "pending",
    "transaction_reference": "tvunjbbd_412829_4b18075d_c7had",
    "refund_reference": null,
    "amount": "10000",
    "currency": "NGN",
    "processor": "instant-transfer",
    "customer": { "first_name": "Drew", "last_name": "Berry", "email": "demo@email.com" },
    "integration": 412829,
    "domain": "live"
  }
}
```

```json
{
  "event": "refund.processed",
  "data": {
    "status": "processed",
    "transaction_reference": "T2154954_412829_3be32076_6lcg3",
    "refund_reference": "132013318360",
    "amount": "5000",
    "currency": "NGN",
    "processor": "mpgs_zen",
    "customer": { "first_name": "Damilola", "last_name": "Kwabena", "email": "damilola@email.com" },
    "integration": 412829,
    "domain": "live"
  }
}
```

```json
{
  "event": "refund.failed",
  "data": {
    "status": "failed",
    "transaction_reference": "T9171231_412325_3be2736c_n6tml",
    "refund_reference": "TRF_9vgfawjnoz58uxy",
    "amount": 20000,
    "currency": "NGN",
    "processor": "instant-transfer",
    "customer": { "first_name": "Tobi", "last_name": "Digz", "email": "tobi@mail.com" },
    "integration": 412325,
    "domain": "live"
  }
}
```

```json
{
  "event": "refund.needs-attention",
  "data": {
    "status": "needs-attention",
    "transaction_reference": "88bfa94509eb96aa9785641c26cc57cc",
    "refund_reference": "TRF_7jn17u9vkqm91efk",
    "amount": 5306,
    "currency": "NGN",
    "customer": { "first_name": null, "last_name": null, "email": "customer@email.com" },
    "integration": 123456,
    "domain": "live",
    "id": "123456",
    "customer_note": "Refund for transaction 88bfa94509eb96aa9785641c26cc57cc",
    "merchant_note": "Refund for transaction 88bfa94509eb96aa9785641c26cc57cc by paystack@email.com"
  }
}
```

Note the refund webhook carries `transaction_reference` (not `reference`) and `amount` is sometimes a **string** in the samples — parse defensively.

`transfer.success` sample (trimmed to the top-level keys; full file has `recipient{…}`, `session{…}`) [OFFICIAL-GH]:

```json
{
  "event": "transfer.success",
  "data": {
    "amount": 100000,
    "createdAt": "2025-08-04T10:32:40.000Z",
    "currency": "NGN",
    "domain": "test",
    "failures": null,
    "id": 860703114,
    "integration": {
      "id": 463433,
      "is_live": true,
      "business_name": "Paystack Demo",
      "logo_path": "…"
    },
    "reason": "Bonus for the week",
    "reference": "acv_9ee55786-2323-4760-98e2-6380c9cb3f68",
    "source": "balance",
    "source_details": null,
    "status": "success",
    "titan_code": null,
    "transfer_code": "TRF_v5tip3zx8nna9o78",
    "transferred_at": null,
    "updatedAt": "2025-08-04T10:32:40.000Z",
    "recipient": {
      "type": "nuban",
      "recipient_code": "RCP_gd9vgag7n5lr5ix",
      "details": { "account_number": "9876543210", "bank_code": "044", "bank_name": "Access Bank" }
    },
    "session": { "provider": null, "id": null },
    "fee_charged": 0,
    "gateway_response": null
  }
}
```

`charge.dispute.create` sample (trimmed) [OFFICIAL-GH]: `data.id`, `data.refund_amount`, `data.currency`, `data.status: "awaiting-merchant-feedback"`, `data.resolution`, `data.domain`, `data.transaction{ id, reference, amount, status, … }`, `data.category: "chargeback"`, `data.customer{…}`, `data.bin`, `data.last4`, `data.dueAt`, `data.resolvedAt`, `data.evidence`, `data.attachments`, `data.note`, `data.history[]`, `data.messages[]`, `created_at`, `updated_at`.

## A.5 Refund API

Verified [OFFICIAL-GH] — `dist/paystack.yaml`:

- `POST /refund` — "Create Refund: Initiate a refund for a previously completed transaction" (`operationId: refund_create`). Request schema `RefundCreate`:

```yaml
RefundCreate:
  type: object
  required: [transaction]
  properties:
    transaction:
      description: The reference of a previosuly completed transaction
      type: string # docs snippets also pass the numeric transaction id
    amount:
      description: Amount to be refunded to the customer. It cannot be more than the original transaction amount
      type: integer
    currency:
      description: Three-letter ISO currency
      type: string
      enum: [GHS, KES, NGN, USD, ZAR]
    customer_note:
      description: Customer reason
      type: string
    merchant_note:
      description: Merchant reason
      type: string
  example:
    transaction: mpkr39h74k
```

- `GET /refund` — List Refunds (`perPage` default 50, `page`, `from`, `to`).
- `GET /refund/{id}` — Fetch Refund (`id` integer, example `15581137`).
- `POST /refund/retry_with_customer_details/{id}` — "Retry a refund with a `needs-attention` status by providing the bank account details of a customer."

Docs snippets [OFFICIAL-GH] (`src/doc/payments/refunds/create-refund/index.sh` and `src/api/refunds/create/index.sh`):

```sh
curl https://api.paystack.co/refund
-H 'authorization: Bearer YOUR_SECRET_KEY'
-H 'cache-control: no-cache'
-H 'content-type: application/json'
-d '{ "transaction":"qufywna9w9a5d8v", "amount":"10000" }'
-X POST
```

```sh
data='{ "transaction": 1641 }'
curl "https://api.paystack.co/refund" -H "Authorization: Bearer YOUR_SECRET_KEY" -H "Content-Type: application/json" -d "$data" -X POST
```

Create response (`create-refund/index.json`) [OFFICIAL-GH]:

```json
{
  "status": true,
  "message": "Refund has been queued for processing",
  "data": {
    "transaction": {
      "id": 1004723697,
      "domain": "live",
      "reference": "T685312322670591",
      "amount": 10000,
      "paid_at": "2021-08-20T18:34:11.000Z",
      "channel": "apple_pay",
      "currency": "NGN",
      "authorization": { "exp_month": null, "exp_year": null, "account_name": null },
      "customer": { "international_format_phone": null },
      "plan": {},
      "subaccount": { "currency": null },
      "split": {},
      "order_id": null,
      "paidAt": "2021-08-20T18:34:11.000Z",
      "pos_transaction_data": null,
      "source": null,
      "fees_breakdown": null
    },
    "integration": 412829,
    "deducted_amount": 0,
    "channel": null,
    "merchant_note": "Refund for transaction T685312322670591 by test@me.com",
    "customer_note": "Refund for transaction T685312322670591",
    "status": "pending",
    "refunded_by": "test@me.com",
    "expected_at": "2021-12-16T09:21:17.016Z",
    "currency": "NGN",
    "domain": "live",
    "amount": 10000,
    "fully_deducted": false,
    "id": 3018284,
    "createdAt": "2021-12-07T09:21:17.122Z",
    "updatedAt": "2021-12-07T09:21:17.122Z"
  }
}
```

Fetch response (`src/api/refunds/fetch/response.json`) [OFFICIAL-GH]:

```json
{
  "status": true,
  "message": "Refund retrieved",
  "data": {
    "integration": 100982,
    "transaction": 1641,
    "dispute": null,
    "settlement": null,
    "domain": "live",
    "amount": 500000,
    "deducted_amount": 500000,
    "fully_deducted": true,
    "currency": "NGN",
    "channel": "migs",
    "status": "processed",
    "refunded_by": "eseyinwale@gmail.com",
    "refunded_at": "2018-01-12T10:54:47.000Z",
    "expected_at": "2017-10-01T21:10:59.000Z",
    "customer_note": "xxx",
    "merchant_note": "xxx",
    "id": 1,
    "createdAt": "2017-09-24T21:10:59.000Z",
    "updatedAt": "2018-01-18T11:59:56.000Z"
  }
}
```

Refund statuses — Verified [OFFICIAL-SNIPPET] (refunds page): _"pending (the refund initiated, waiting for response from the processor), processing (the refund has been received by the processor), processed (the refund has successfully been processed by the processor), and failed (the refund can't be processed)"_; plus **`needs-attention`** [OFFICIAL-GH] (retry endpoint + `refund.needs-attention` event). Full refund if `amount` omitted; partial refund by passing `amount` [OFFICIAL-SNIPPET].

## A.6 Test mode: keys, cards, bank accounts

Verified [OFFICIAL-SNIPPET] from https://paystack.com/docs/payments/test-payments/ (page blocked; values from search snippets of the page — re-check the live table before hard-coding):

- _"Test mode exists to create a safe sandbox environment where you can use Paystack without using real money."_ _"The expiry date for each card can be any date in the future."_ (Some snippets show `09/27` in the table's expiry column.)

| Scenario                                                    | Card number                                              | CVV | PIN  | OTP / other                                                                              |
| ----------------------------------------------------------- | -------------------------------------------------------- | --- | ---- | ---------------------------------------------------------------------------------------- |
| No validation (reusable)                                    | `4084 0840 8408 4081` (shown as "408 408 408 408 408 1") | 408 | —    | —                                                                                        |
| PIN validation                                              | `5078 5078 5078 5078 12`                                 | 081 | 1111 | —                                                                                        |
| PIN + OTP validation (Verve)                                | `5060 6666 6666 6666 666`                                | 123 | 1234 | 123456                                                                                   |
| PIN + Phone + OTP (Verve)                                   | `5078 5078 5078 5078 04`                                 | 884 | 0000 | 123456; _"phone number … if less than 10 numeric characters, the transaction will fail"_ |
| Bank Auth Simulation (reusable)                             | `5192 6027 2058 4796`                                    | 123 | —    | —                                                                                        |
| Token Not Generated (failure)                               | `4084 0800 0000 5408` (shown as "408 408 0000005 408")   | 001 | —    | —                                                                                        |
| Second failure card (label not captured; likely "Declined") | `4084 0800 0000 0409` (shown as "408 408 0000000 409")   | 000 | —    | —                                                                                        |
| Timeout error                                               | `5078 5078 5078 5078 53`                                 | —   | —    | —                                                                                        |
| Insufficient funds                                          | `5060 6650 6066 5060 67`                                 | —   | —    | —                                                                                        |

- Refund test cards — [OFFICIAL-SNIPPET]: _"To test for certain refunds scenarios, you can use specific cards when completing a transaction. The transaction will be successful but the card used determines the response of a refund request. The title on the cards show what the refund status will be when you initiate a refund on the transaction."_ (card numbers not captured → NOT VERIFIED).
- Test bank account (bank channel) — [OFFICIAL-SNIPPET]: **Bank: Zenith Bank, Account number: 0000000000, Birthday: any date, All OTP: 123456**.
- Test dedicated virtual accounts: use `preferred_bank: "test-bank"` with the test secret key [OFFICIAL-SNIPPET].
- Mobile money test numbers: **not found** in official snippets → NOT VERIFIED.
- A verify response in test mode shows `"domain": "test"`, `"bank": "TEST BANK"` (see A.3 sample) [OFFICIAL-GH].

## A.7 Popup / InlineJS

- Script (v2, current) — Verified [OFFICIAL-GH] (`src/doc/developer-tools/inlinejs/installation/cdn.sh`, `guides/inlinejs-v1-to-v2/dependency/index.html`):

```html
<script src="https://js.paystack.co/v2/inline.js"></script>
```

npm: `@paystack/inline-js` (latest **2.25.0**, 2026-09-08; registry verified) — `npm install @paystack/inline-js`.

- Initialise — [OFFICIAL-GH] (`inlinejs/initialize/cdn.js`): `const popup = new PaystackPop();` (with the npm import the docs write `const popup = new Paystack()`).
- New transaction — [OFFICIAL-GH] (`inlinejs/new-transaction/index.js`):

```js
const popup = new Paystack();

popup.newTransaction({
  key: 'pk_domain_xxxxxx',
  email: 'sample@email.com',
  amount: 23400,
  onSuccess: (transaction) => {
    console.log(transaction);
  },
  onLoad: (response) => {
    console.log('onLoad: ', response);
  },
  onCancel: () => {
    console.log('onCancel');
  },
  onError: (error) => {
    console.log('Error: ', error.message);
  },
});
```

- **Resume with `access_code`** (backend initialize → frontend popup, no redirect) — [OFFICIAL-GH] (`inlinejs/resume-transaction/index.js`):

```js
const popup = new Paystack();

popup.resumeTransaction(access_code);
```

[OFFICIAL-SNIPPET] (InlineJS page): _"With the resumeTransaction method, you can initiate a transaction from your backend using the initialize endpoint, then complete the transaction in the frontend without redirecting … allowing the user to choose their preferred payment channel."_ `newTransaction(options)` is synchronous; both return a `PopupTransaction`. `onSuccess()` fires on a successful transaction; `onCancel()` when the user closes the Popup. Other documented snippets: `onLoad`, `onError`, `onElementsMount`, `preloadTransaction`, `cancelTransaction`, `checkout`, `paymentRequest`, split/subscription options. Amount for the popup is also the integer subunit (the v1 snippet multiplies by 100).

- Legacy v1 (still shown on the payments overview page) — [OFFICIAL-GH] (`src/doc/payments/overview/popup/index.html` + `accept-payment/initialize/index.js`):

```html
<script src="https://js.paystack.co/v1/inline.js"></script>
```

```js
var handler = PaystackPop.setup({
  key: 'YOUR_PUBLIC_KEY', // Replace with your public key
  email: document.getElementById('email-address').value,
  amount: document.getElementById('amount').value * 100, // the amount value is multiplied by 100 to convert to the lowest currency unit
  currency: 'NGN', // Use GHS for Ghana Cedis or USD for US Dollars
  ref: 'YOUR_REFERENCE', // Replace with a reference you generated
  callback: function (response) {
    //this happens after the payment is completed successfully
    var reference = response.reference;
    // Make an AJAX call to your server with the reference to verify the transaction
  },
  onClose: function () {
    alert('Transaction was not completed, window closed.');
  },
});
handler.openIframe();
```

## A.8 Paystack adapter checklist (derived)

1. `POST https://api.paystack.co/transaction/initialize` with `Authorization: Bearer sk_*`, JSON `{email, amount:int subunit, currency, reference, callback_url, metadata, channels}` → store `data.reference`, hand `data.access_code` to `popup.resumeTransaction()` or redirect to `data.authorization_url`.
2. On callback (`?reference=`) and/or `charge.success` webhook → `GET /transaction/verify/{reference}` → accept only `data.status === "success"` with matching `amount`/`currency`; idempotent on `reference`.
3. Webhook endpoint: read raw body, `hex(HMAC_SHA512(secret_key, raw))` must equal `x-paystack-signature`; optionally allow only the three IPs; respond `200` immediately; process asynchronously; expect retries (dedupe on `event` + `data.id`/`data.reference`).
4. Refunds: `POST /refund {transaction, amount?, currency?, customer_note?, merchant_note?}` → `data.status` starts `pending`; track `refund.pending/processing/processed/failed/needs-attention` webhooks (keyed by `transaction_reference`/`refund_reference`), or poll `GET /refund/{id}`.

---

# PART B — Termii

Every developers.termii.com page is blocked in this session. Items below are either **[OFFICIAL-SNIPPET]** (search-engine snippets of the official pages, restricted to the official domain) or **NOT VERIFIED / [THIRD-PARTY]**. Official page URLs (all confirmed to exist via search results): `https://developers.termii.com/` (index), `/messaging`, `/messaging-api`, `/authentication`, `/sender-id`, `/send-token`, `/verify-token`, `/in-app-token`, `/voice-token`, `/balance`, `/history`, `/events-and-reports`, `https://www.developers.termii.com/incoming/`, `/error`, `/status`, `/number`, `/templates`, `/campaign`, `/contacts`, `/phonebook`.

## B.1 Base URL — account-specific

- Verified [OFFICIAL-SNIPPET] (developers.termii.com): _"Your Termii account has its own base URL, which you should use in all API requests, and your base URL can be found on your dashboard. The base URL is used to route your request to the appropriate 'regulatory region' and to optimize traffic between data centers in the region."_ All official examples are written as **`https://BASE_URL/api/...`**.
- Which concrete host is "current": **NOT VERIFIED from official docs (fetch blocked)**. Community evidence (2026-09-23):
  - `https://v3.api.termii.com` — the default in SDKs updated 2025–2026: `Douglasokolaa/termii-php` (`initialize(string $apiKey, string $baseUrl = 'https://v3.api.termii.com')`), `zeevx/lara-termii` CHANGELOG (_"The base URL is now configurable (Termii issues account-specific base URLs) and defaults to `https://v3.api.termii.com`"_), `@brvhprince/termii-js` README (_"The default base URL is now `https://v3.api.termii.com/api/`. Base URLs are account-specific"_); ~220 GitHub code hits, all recent.
  - `https://api.ng.termii.com` — the legacy Nigeria host; still the `servers` entry in the api-evangelist mirror; ~1,150 GitHub code hits (mostly older code).
  - Adapter rule: make the base URL a **configuration value copied from the Termii dashboard**, default to `https://v3.api.termii.com`, keep `https://api.ng.termii.com` as a fallback option. Use HTTPS only (the official error page says using `http` instead of `https` yields "Unauthorized").

## B.2 Authentication and request format

- Verified [OFFICIAL-SNIPPET] (`/authentication`): _"API calls are authenticated by including your API key in the body of the request you make. Your API key can be obtained from your Termii Dashboard."_ Official examples put **`api_key` in the JSON body for POST** and as the **`api_key` query parameter for GET** (`/api/get-balance?api_key=YourAPIKey`, `/api/sender-id?api_key=api-key`, `/api/sms/inbox?api_key=…`). There is **no** `Authorization` header. `Content-Type: application/json` on every example.
- Responses are JSON; standard HTTP status codes indicate success/failure [OFFICIAL-SNIPPET].

## B.3 POST /api/sms/send (single message)

- Endpoint — Verified [OFFICIAL-SNIPPET]: `https://BASE_URL/api/sms/send`, **POST**. _"The Messaging endpoint enables you to send a message to a single recipient via SMS, using either the Generic (Promotional) or DND (Transactional) route."_ Request fields named in the official snippets: `api_key`, `to`, `from`, `sms`, `type` (e.g. `"plain"`), `channel` (`"generic"`, `"dnd"`, `"whatsapp"`), and for WhatsApp a `media` object with `url` and `caption`.
- Channel guidance — Verified [OFFICIAL-SNIPPET]: _"The generic (non-DND) route is meant strictly for promotional messages and should not be used for sending OTP or transactional messages, as these are best handled via the DND (transactional) route."_ _"Messages sent through the generic route will not deliver to numbers on Do-Not-Disturb (DND) and are subject to time restrictions in Nigeria for MTN numbers (no message delivery between 8PM and 8AM WAT)."_ → use `channel: "dnd"` for OTP/transactional.
- Sample request (Postman mirror of the docs, [THIRD-PARTY] `api-evangelist/termii`; field set matches the official snippets):

```json
{
  "api_key": "Your API key",
  "to": "23490126727",
  "from": "Termii",
  "sms": "Hi there, testing Termii",
  "type": "plain",
  "channel": "generic"
}
```

WhatsApp with media ([THIRD-PARTY] mirror; official snippet confirms `media.url`/`media.caption`):

```json
{
  "api_key": "Your API key",
  "to": "23490126727",
  "from": "Termii",
  "sms": "Hi there, testing Termii",
  "type": "plain",
  "channel": "whatsapp",
  "media": { "url": "https://example.com/image.jpg", "caption": "your media caption" }
}
```

- Field descriptions ([THIRD-PARTY] mirror + memory; NOT VERIFIED verbatim): `to` — destination number(s) in international format (string, or array of up to 100 numbers); `from` — registered sender ID, alphanumeric **3–11 characters** (or a device name for WhatsApp); `sms` — message text; `type` — `plain` (also `unicode`); `channel` — `generic` | `dnd` | `whatsapp`.
- Success response — Verified [OFFICIAL-SNIPPET] (messaging page):

```json
{
  "code": "ok",
  "message_id": "9122821270554876574",
  "message": "Successfully Sent",
  "balance": 9,
  "user": "Peter Mcleish"
}
```

A `message_id_str` field also appears in some official examples and in real payloads (string copy of the 64-bit id — parse `message_id` as a string, never as a JS number).

## B.4 Bulk: POST /api/sms/send/bulk

- Verified [OFFICIAL-SNIPPET] (`/messaging-api`): endpoint `https://BASE_URL/api/sms/send/bulk`; `to` is an **array** of numbers, e.g. `["2347880234567","2347880234567"]`; other fields `from`, `sms`, `type`, `channel`, `api_key` as above. Same response shape as single send.
- Limits: **NOT VERIFIED (fetch blocked)** — the docs' `to` description historically says the array _"takes only 100 phone numbers at a time"_ (third-party mirror repeats "up to 100 recipients"); Termii's blog post is titled _"Termii Bulk SMS API: Send SMS to up to 10k phone numbers with a single API request"_ (https://blog.termii.com/termii-bulk-sms-api-send-sms-to-up-to-10k-phone-numbers-with-a-single-api-request — blocked). Chunk at ≤100 unless the dashboard/account manager confirms a higher cap.
- Also documented ([THIRD-PARTY] mirror): `POST /api/sms/number/send` `{api_key, to, sms}` — sends from an auto-generated number without a sender ID.

## B.5 Sender ID

- List — Verified [OFFICIAL-SNIPPET]: `GET https://BASE_URL/api/sender-id?api_key=api-key` returns sender IDs _"with their status (such as active or pending), creation date, company name, and use case"_. Paginated response ([THIRD-PARTY] copy of docs sample in `abduljeleelng/termii-nodejs-sdk`):

```json
{
  "current_page": 1,
  "data": [
    {
      "sender_id": "string",
      "status": "unblock",
      "company": "string",
      "usecase": null,
      "country": null,
      "created_at": "timestamp"
    }
  ],
  "first_page_url": "string",
  "last_page": 47,
  "total": 704
}
```

- Request — Verified [OFFICIAL-SNIPPET] (`/sender-id`): **`POST https://BASE_URL/api/sender-id/request`**; _"Once submitted, the request is sent to Termii's admin team for review and approval."_ Official sample body shown in the snippet:

```json
{
  "api_key": "Your API key",
  "sender_id": "Acme",
  "use_case": "Your OTP code is zxsds",
  "company": "Acme Corp"
}
```

Field-name caveat: the request sample uses **`use_case`** while the list response uses **`usecase`**; community SDKs note _"Termii's docs disagree on the field name"_ and send both. Send both keys to be safe. Response body for the request call: NOT VERIFIED (typically `{"code":"ok","message":"Sender Id request submitted"}` — confirm).

- Sender-ID whitelisting can also be requested via Termii support [OFFICIAL-SNIPPET].

## B.6 Token (OTP) API

- Send — Verified [OFFICIAL-SNIPPET] (`/send-token`): `POST https://BASE_URL/api/sms/otp/send`. Parameters: `api_key`, `message_type` (`NUMERIC` | `ALPHANUMERIC`), `to`, `from`, `channel` (`generic` | `dnd` | `whatsapp` | `email`), `pin_attempts` (e.g. 10), `pin_time_to_live` (minutes, e.g. 5), `pin_length` (e.g. 8; 4–8), `pin_placeholder` (e.g. `"< 12345678 >"`), `message_text`, `pin_type` (`NUMERIC`). Response fields: `smsStatus` (`"Message Sent"`), `phone_number`, `to`, `pinId`.

```json
{
  "api_key": "Your API key",
  "message_type": "NUMERIC",
  "to": "2348109077743",
  "from": "Acme",
  "channel": "dnd",
  "pin_attempts": 10,
  "pin_time_to_live": 5,
  "pin_length": 6,
  "pin_placeholder": "< 1234 >",
  "message_text": "Your pin is < 1234 >",
  "pin_type": "NUMERIC"
}
```

```json
{
  "smsStatus": "Message Sent",
  "phone_number": "2347065250817",
  "to": "2347065250817",
  "pinId": "b1f2242a-44c5-4eed-94bc-8d..."
}
```

- Verify — Verified [OFFICIAL-SNIPPET] (`/verify-token`): `POST https://BASE_URL/api/sms/otp/verify` with `{api_key, pin_id, pin}`; _"A token can either be confirmed as verified or expired based on the timer set for the token."_ Response sample from the snippet:

```json
{ "pinId": "c8dcd048-5e7f-4347-8c89-4470c3af0b", "verified": "True", "msisdn": "2348109077743" }
```

`verified` is `true`/`"True"` on success and the string `"Expired"` when the PIN expired ([THIRD-PARTY] mirror: `verified: boolean | string`). Treat anything other than boolean true / `"True"` as failure.

- Also: `POST /api/sms/otp/generate` (in-app token, returns the OTP: `{status, data:{pin_id, otp, phone_number, phone_number_other}}`), `POST /api/sms/otp/send/voice` (`phone_number, pin_attempts, pin_time_to_live, pin_length`), email token and WhatsApp token pages exist ([THIRD-PARTY] mirror; endpoints confirmed by official page titles only).

## B.7 Balance

- Verified [OFFICIAL-SNIPPET] (`/balance`): **`GET https://BASE_URL/api/get-balance?api_key=YourAPIKey`** — _"returns your total balance and balance information from your wallet, such as currency."_
- Response JSON: NOT VERIFIED verbatim. Third-party mirror schema: `{ "user": "...", "balance": 785.57, "currency": "NGN" }` (mirror also lists an `application` field). Read `balance` (number) and `currency`.

## B.8 Message history / status polling

- Verified [OFFICIAL-SNIPPET] (`/history`): `GET https://BASE_URL/api/sms/inbox?api_key=YourAPIKey` returns all reports; _"query a single message by adding `message_id` as a query parameter"_ (the `message_id` from the send response). Item fields seen in the official sample: `sender`, `receiver`, `message`, `amount`, `status`, `sms_type` (e.g. `generic`), `send_by`, `message_id`, `created_at` (mirror adds `reroute`, `media_url`, `notify_url`, `notify_id`).
- Status strings seen in official samples: **`Delivered`**, **`DND Active on Phone Number`**, **`Failed`**; other values seen in real traffic/community: `Message Sent`, `Sent`, `Message Failed`, `Rejected`, `Expired`, and composite strings such as `"DELIVERED | Message delivered to handset"` in webhooks. Match case-insensitively on the prefix (`delivered`, `dnd`, `fail`, `reject`, `expire`).

## B.9 Delivery-report / inbound webhooks (Events and Reports)

- Configure: add your webhook URL in the Termii developer console (Events & Reports / webhook config; the account console path is `https://accounts.termii.com/#/account/webhook/config` per SDK README — NOT VERIFIED). One account-wide URL, not per-request. Termii sends **POST**, `Content-Type: application/json` — Verified [OFFICIAL-SNIPPET].
- Signature — Verified [OFFICIAL-SNIPPET] (`/events-and-reports`): _"It is important to verify that an event originated from Termii by validating the signature … a valid event is raised with a header **X-Termii-Signature** which is a HMAC SHA512 signature of the event payload signed with your secret key."_ Verify against the **raw body bytes**. Which "secret key" is not stated on the page (community implementations use the account API key and note the ambiguity; the dashboard webhook config page shows the key to use — confirm there).
- Expected response: the docs do not specify (NOT VERIFIED); return `200` quickly. Retry policy: not documented (NOT VERIFIED).
- Event types: `inbound`, `outbound` (delivery report), `device_status` (WhatsApp device offline/online). The webhook dashboard shows _"event types either Inbound or Outbound"_ [OFFICIAL-SNIPPET].
- **Inbound** sample — Verified [OFFICIAL-SNIPPET] (`www.developers.termii.com/incoming/`):

```json
{
  "type": "inbound",
  "id": "8248611476370959318",
  "message_id": "3905204342778053556",
  "receiver": "12022214836",
  "sender": "2347069549231",
  "message": "Great ",
  "received_at": "2020-12-16T10:51:03.000000Z",
  "cost": null,
  "command": "Received",
  "status": "Received",
  "channel": null
}
```

- **Outbound (delivery report)** — official sample NOT captured (fetch blocked). Field list per the official schema as modelled by `ekunemmanuel/termii` [THIRD-PARTY]: `type`, `id`, `message_id`, `receiver`, `sender`, `message`, `sent_at`, `cost`, `status`, `channel` (`dnd` | `whatsapp` | `generic`). A **real captured payload** (test fixture in `Mane-Olawale/termii`, [THIRD-PARTY]) shows the production shape, which carries extra carrier fields:

```json
{
  "type": "outbound",
  "message_id": "902022080211300900000078460",
  "message_id_str": "902022080211300900000078460",
  "receiver": "2348147386362",
  "sender": "MAlert",
  "message": "Hi there, testing Gotrade",
  "sent_at": "2022-08-02 11:30:11",
  "cost": "3.9",
  "pages": "1",
  "command": "deliver",
  "status": "DELIVERED | Message delivered to handset",
  "channel": "DND",
  "msgtype": 5,
  "origid": "902022080211300900000078460",
  "messagestate": "Delivered",
  "notify_id": "902022080211300900000078460"
}
```

Adapter rule: key on `message_id` (string), read `status` (and `messagestate` when present), treat `type` loosely (one SDK notes the outbound `type` value can vary, e.g. `delivery_report`), ignore unknown fields.

- **device_status** sample (captured, [THIRD-PARTY]): `{"type":"device_status","status":"disconnected","device_id":"e0c5a9b-0136-4751-9be9-a3c9zzTc0a19","name":"TermiiWh"}`.

## B.10 Phone number format

- Official examples everywhere use **international format with country code and no `+`**: `23490126727`, `2347880234567`, `2348109077743`; API responses return numbers like `2347065250817`; Number API uses a separate `country_code` (`234` / `NG`) parameter. The exact docs sentence ("Phone number must be in the international format") was NOT captured verbatim → NOT VERIFIED, but all official samples agree. Adapter: normalise to E.164 digits **without** the leading `+` (e.g. `+2348012345678` → `2348012345678`).

## B.11 Errors and rate limits

- Verified [OFFICIAL-SNIPPET] (`/error`): _"Termii uses HTTP response codes to indicate the success or failure of requests. Codes in the 5xx range indicate an error from Termii's end (these are rare)."_ Documented situations: **Unauthorized** — _"If you are getting Unauthorized error while passing the right key, check your API endpoint. This could also occur when you use http instead of https"_; account deactivated/disabled by administrators; _"that particular country route or intended destination is not set up for the user … contact your account manager to activate the route"_; _"Your device has reached the daily limit of the message volume activated on your device"_; **Invalid Sender Id** — _"received when the inputed sender ID is not registered or misspelt."_
- Error JSON shape: NOT VERIFIED (fetch blocked). Third-party mirror models `{ "message": "…" }`; success bodies carry `"code": "ok"`. Treat any non-2xx, or 2xx without `code == "ok"` / `message_id`, as failure and log the body.
- Rate limits: **not published numerically** by Termii (mirror `api-evangelist/termii` rate-limits note: _"Termii does not publish explicit numeric per-second or per-minute API request limits"_); practical caps are the per-request recipient limit (≤100 in `to`), wallet balance, sender-ID approval/route, and the WhatsApp device daily limit. Implement retry with exponential backoff on 429/5xx.

## B.12 Termii adapter checklist (derived)

1. Config: `TERMII_BASE_URL` (from dashboard; default `https://v3.api.termii.com`), `TERMII_API_KEY`, `TERMII_SENDER_ID` (approved, 3–11 chars), `TERMII_WEBHOOK_SECRET`.
2. Send: `POST {BASE}/api/sms/send` JSON `{api_key, to: "234…", from, sms, type: "plain", channel: "dnd"}`; persist `message_id` (string) and `balance`.
3. Bulk: `POST {BASE}/api/sms/send/bulk` with `to: [...]` chunked at 100.
4. OTP: `POST {BASE}/api/sms/otp/send` → store `pinId`; `POST {BASE}/api/sms/otp/verify {api_key, pin_id, pin}` → success iff `verified === true || "True"`.
5. Balance: `GET {BASE}/api/get-balance?api_key=…`.
6. Webhook: verify `X-Termii-Signature` = `hex(HMAC_SHA512(secret, raw_body))`; branch on `type` (`inbound` / `outbound` / `device_status`); update delivery state by `message_id`; respond 200.
7. Sender ID onboarding: `POST {BASE}/api/sender-id/request {api_key, sender_id, use_case, usecase, company}`; poll `GET {BASE}/api/sender-id?api_key=…` for `status`.

---

## Source list

Paystack (official, reachable): https://github.com/PaystackOSS/openapi (`dist/paystack.yaml`), https://github.com/PaystackOSS/doc-code-snippets (`src/doc/payments/{accept-payment,verify-payment,webhooks,refunds,metadata}`, `src/doc/developer-tools/inlinejs`, `src/api/{transactions,refunds}`), https://github.com/PaystackOSS/paystack-cli (`lib/paystack/webhooks.js`), https://registry.npmjs.org/@paystack%2Finline-js.
Paystack (official, blocked — snippets only): https://paystack.com/docs/payments/accept-payments/, https://paystack.com/docs/payments/verify-payments/, https://paystack.com/docs/payments/webhooks/, https://paystack.com/docs/api/transaction/, https://paystack.com/docs/api/refund/, https://paystack.com/docs/payments/refunds/, https://paystack.com/docs/payments/test-payments/, https://paystack.com/docs/developer-tools/inlinejs/, https://support.paystack.com/en/articles/2130946 (IP whitelisting), https://support.paystack.com/en/articles/2123458 (API keys and webhooks).
Termii (official, blocked — snippets only): https://developers.termii.com/, /messaging, /messaging-api, /authentication, /sender-id, /send-token, /verify-token, /balance, /history, /events-and-reports, https://www.developers.termii.com/incoming/, /error.
Termii (third-party, reachable): https://github.com/api-evangelist/termii, https://github.com/Mane-Olawale/termii (tests/WebhookTest.php), https://github.com/ekunemmanuel/termii (src/types/index.ts, src/utils/webhooks.ts), https://registry.npmjs.org/@brvhprince%2Ftermii-js (README), https://github.com/zeevx/lara-termii (CHANGELOG), https://github.com/Douglasokolaa/termii-php, https://github.com/abduljeleelng/termii-nodejs-sdk/blob/main/docs/senderId.md.
