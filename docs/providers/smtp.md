# SMTP (email) — provider setup and operating notes

Adapter: `packages/integrations/src/mail/smtp.ts` (`SmtpMailProvider`, nodemailer) behind the
`MailProvider` interface in `packages/integrations/src/mail/types.ts`. Development adapter:
`packages/integrations/src/mail/dev.ts`. Templates: `packages/integrations/src/templates`.

## 1. Choosing a provider

Any SMTP relay works as long as it offers authenticated submission over TLS with a valid
certificate. Typical choices for a Nigerian business:

| Provider                    | Host                                | Port / mode                  | Notes                                                                                              |
| --------------------------- | ----------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------- |
| Google Workspace SMTP relay | `smtp-relay.gmail.com`              | 587 STARTTLS or 465 implicit | Requires the relay to be enabled in the Workspace admin console; SPF `include:_spf.google.com`.    |
| Amazon SES (SMTP interface) | `email-smtp.<region>.amazonaws.com` | 587 STARTTLS or 465 implicit | SMTP credentials are separate from IAM keys; sandbox accounts can only send to verified addresses. |
| SendGrid                    | `smtp.sendgrid.net`                 | 587 STARTTLS or 465 implicit | Username is literally `apikey`; DKIM via CNAMEs.                                                   |
| Postmark / Mailgun / Zoho   | provider host                       | 587 STARTTLS                 | Similar; check their DKIM instructions.                                                            |
| Own Postfix/Exim            | your host                           | 587 STARTTLS                 | You must publish SPF/DKIM/DMARC yourself and maintain reputation.                                  |

Whichever you choose, add its hostname to the operator allow-list (`SMTP_ALLOWED_HOSTS`, exact
host or `.suffix`) before the admin form will accept it.

## 2. Transport security modes

| Mode           | Port                  | nodemailer options set by `buildTransportOptions` | Use                                                                                                 |
| -------------- | --------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `implicit-tls` | 465                   | `secure: true`                                    | TLS from the first byte.                                                                            |
| `starttls`     | 587 (or 25 on relays) | `secure: false, requireTLS: true`                 | Plaintext greeting, then mandatory upgrade; the session fails instead of falling back to plaintext. |
| `none`         | 1025                  | `ignoreTLS: true`                                 | **Development only** (Mailpit). Refused unless `allowPrivate` is set, which production never sets.  |

Certificate verification is never disabled. `tls.rejectUnauthorized` stays at its default,
`assertSecureTransportOptions` refuses any option set that turns it off, and TLS 1.2 is the
minimum. The TLS server name is the configured hostname even though the socket is opened to the
address that passed the destination check. If a connection test fails with a certificate error
(`CERT_HAS_EXPIRED`, `DEPTH_ZERO_SELF_SIGNED_CERT`, `ERR_TLS_CERT_ALTNAME_INVALID`), fix the
server certificate or use the hostname that the certificate is issued for; do not work around
it.

## 3. Destination allow-list and SSRF protection

Every connection (test, send) first runs `checkDestination` from
`packages/integrations/src/net/ssrf.ts`:

- the host must match `SMTP_ALLOWED_HOSTS` when that list is non-empty;
- `localhost`, `*.localhost`, `*.internal`, `metadata.google.internal`, loopback, RFC 1918,
  link-local (169.254.0.0/16, including the cloud metadata address), CGNAT and reserved ranges are
  blocked, after DNS resolution, so a public name pointing at a private address is rejected too;
- the connection is then opened to the resolved address (IPv4 preferred) that passed the check.

`allowPrivate` lifts the private-address rule and enables plaintext SMTP. It is derived from
`NODE_ENV !== 'production'` in `smtpConfigFromEnv` and `createMailProvider` refuses it in
production. The allow-list is an operator control (environment), deliberately not editable from
the admin form.

## 4. Admin configuration (Admin → Integrations → Email)

| Field                   | Stored as                                             | Notes                                                                                                        |
| ----------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| SMTP host               | setting                                               | Must pass the allow-list.                                                                                    |
| Port                    | setting                                               | 465 or 587 as above.                                                                                         |
| Transport security      | setting                                               | `implicit-tls` or `starttls` (admin form never offers `none`).                                               |
| Username                | setting (masked on display, e.g. `ap•••@example.com`) |                                                                                                              |
| Password                | secret (envelope-encrypted, write-only)               | Only presence/fingerprint is shown after saving.                                                             |
| Sender name / address   | setting                                               | Address must be in an approved sender domain.                                                                |
| Reply-to                | setting                                               | Optional mailbox that receives replies.                                                                      |
| Approved sender domains | setting                                               | Domains whose SPF/DKIM/DMARC are published; sends from other domains are refused with `sender_not_approved`. |
| Test recipient          | setting                                               | Receives explicit test emails; always displayed before sending.                                              |

Schemas: `smtpConfigSchema` (adapter input, includes the password) and `smtpSettingsSchema`
(non-secret admin settings); descriptors in `SMTP_ADMIN_FIELDS`.

SMTP settings and secrets never reach the browser. Admin screens only receive `describe()`
output (host, port, mode, masked username, sender) and sanitised check results.

### Save, test and activate

- **Save** stores the configuration (state `configured_unverified`); nothing is contacted.
- **Connection test** (`verifyConnection()`) resolves and checks the destination, opens the
  connection with the selected TLS mode, authenticates (`EHLO`/`AUTH`) and reports latency, the
  TLS mode and a sanitised message. Success sets `connected`; failures set `degraded` or leave
  `configured_unverified` with the failure reason.
- **Test email** is a separate, permission-controlled action: it renders the `test_message`
  template and sends it to the configured test recipient, shown on the confirmation dialog. Check
  the received message's `Authentication-Results` header for `spf=pass`, `dkim=pass`,
  `dmarc=pass`.
- **Activate** switches the active configuration version; it requires a successful connection
  test and step-up authentication. Saving never shows "Connected".

## 5. SPF, DKIM and DMARC

`dnsChecklist(domain, options)` produces the exact records to publish and `checkDnsRecords`
optionally verifies their presence (`present` / `missing` / `unknown`; resolver failures never
throw). Example for `simplexd.co` sending through Google Workspace with DMARC reports to
`dmarc@simplexd.co`:

| Record | Host                            | Type | Value                                                                      |
| ------ | ------------------------------- | ---- | -------------------------------------------------------------------------- |
| SPF    | `simplexd.co`                   | TXT  | `v=spf1 include:_spf.google.com -all`                                      |
| DKIM   | `google._domainkey.simplexd.co` | TXT  | `v=DKIM1; k=rsa; p=<public key from the provider>`                         |
| DMARC  | `_dmarc.simplexd.co`            | TXT  | `v=DMARC1; p=none; rua=mailto:dmarc@simplexd.co; adkim=r; aspf=r; pct=100` |

Notes:

- One SPF record per domain; merge `include:` mechanisms if a record already exists and keep the
  total DNS lookups at 10 or fewer. Use `-all` once every legitimate sender is listed.
- Some providers (SendGrid, SES with Easy DKIM) publish DKIM as CNAMEs; pass `dkimCnameTarget` to
  the checklist to get that form.
- Start DMARC at `p=none`, review aggregate reports for a few weeks, then move to `quarantine`
  and finally `reject`. The `From:` domain must align with SPF or the DKIM `d=` domain.
- Deliverability also depends on reverse DNS and the relay's reputation, which the provider
  manages.

## 6. Mailpit in development

`docker-compose.yml` runs Mailpit (`axllent/mailpit`) with SMTP on `localhost:1025` and the web
UI at http://localhost:8025. `.env.example` sets:

```
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
SMTP_SECURITY=none
MAIL_FROM_ADDRESS=no-reply@localhost
```

In development and test, `mailProviderFromEnv` returns the labelled development adapter, which
stores every message in an in-memory outbox and, when `SMTP_HOST` is set, also forwards it to
Mailpit (`allowPrivate` is true outside production, which is what permits `localhost` and
plaintext). The development adapter refuses to start when `NODE_ENV=production`, and the SMTP
adapter refuses `allowPrivate` in production, so Mailpit settings can never be used live.

## 7. Send log, delivery semantics and retries

Each send produces a `delivery_attempts` row: `queued` → `accepted` when the server answers
`250` after `DATA` → `failed`/`rejected` on error. `MailSendResult.response` keeps the sanitised
server line (e.g. `250 2.0.0 OK queued as ABC123`) and `providerMessageId` the `Message-ID`,
which is derived deterministically from the idempotency key so that retries of the same
notification carry the same id and receivers dedupe them.

**SMTP acceptance is not delivery.** Plain SMTP gives no downstream feedback; the send log shows
`accepted`, never `delivered`, unless a provider feedback loop (bounce/complaint webhooks) is
configured later. Do not present "delivered" to users for SMTP-only setups.

The send log is _Admin → Communications → Delivery log_ (`notifications.templates.manage`): every
attempt with a masked recipient, the status timeline (queued → accepted by relay → bounced),
the sanitised failure reason, the provider message id and a _Retry_ action for failed or rejected
attempts. A retry re-renders the original message for the same recipient under the scope
`retry:<attempt id>`, so repeating it returns the existing retry and never sends twice; it is
audited as `notifications.delivery.retried`. _Admin → Communications → Test send_ sends an explicit
test email to a staff-entered address and shows the relay's answer separately from delivery.

Failure codes returned by `sanitizeMailError` and their queue treatment:

| Code                  | Meaning                                                                                              | Retry                             |
| --------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------- |
| `auth`                | AUTH rejected (wrong username/password, or the provider requires an app password / SMTP credentials) | no                                |
| `connection`          | connection refused/reset                                                                             | yes                               |
| `timeout`             | connect/greeting/socket timeout                                                                      | yes                               |
| `dns`                 | host could not be resolved                                                                           | yes                               |
| `tls`                 | certificate or handshake failure                                                                     | no (fix the certificate/hostname) |
| `envelope`            | sender or recipient rejected; 4xx responses are retried, 5xx are not                                 | depends                           |
| `message`             | content rejected (size, headers)                                                                     | no                                |
| `destination`         | blocked by the allow-list/SSRF policy                                                                | no                                |
| `sender_not_approved` | sender domain not approved                                                                           | no                                |
| `invalid_recipient`   | malformed recipient                                                                                  | no                                |

Credentials never appear in diagnostics: the password, its base64 forms, the username and any
`AUTH PLAIN/LOGIN` payload are redacted from every message before it is stored or shown.

## 8. Bounces, complaints and suppression (limits)

- With a bare SMTP relay, bounces arrive as emails to the sender or reply-to mailbox and cannot
  be processed automatically. Point `Reply-to` at a monitored mailbox and record bouncing
  addresses from _Admin → Communications → Suppressions → Record an email bounce or complaint_
  (`POST /api/v1/admin/notifications/bounces`): hard bounces and complaints suppress the address
  and mark the last attempt `bounced`; soft bounces only mark the attempt. Lifting a suppression
  needs a reason and is audited (`notifications.suppression.removed`).
- Providers with feedback loops (SES notifications, SendGrid/Postmark/Mailgun event webhooks)
  can populate `suppressions` automatically; this is a later integration and is not part of the
  SMTP adapter. Until then the send log will show `accepted` for messages that later bounce.
- Suppressed addresses are skipped before sending and recorded as `suppressed` attempts.

## 9. Templates

Templates live in the `templates` table (seeded from `notificationTemplates` in
`packages/db/src/seed/reference.ts`) with `{{variable}}` placeholders. `renderTemplate` is strict
(missing variables raise an error listing them), escapes values in HTML and leaves the text body
verbatim. `renderEmail` wraps the body in the branded layout (`wrapHtmlLayout`: single column,
inline styles, light background, no external images or scripts, `lang` and a real heading) and
always produces a plain-text part. `previewTemplate` renders with sample values for the admin
preview, showing `[name]` for variables without a sample.

_Admin → Communications → Templates_ edits templates as new versions (approved versions are
immutable), previews them on the server in a sandboxed frame with a fixed catalogue of sample
values (never customer records), activates a version (retiring the previous one) and rolls back
by copying an older version into a new one, so the history is never rewritten.

## 10. Troubleshooting

| Symptom                                            | Likely cause                                                       | Action                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `SMTP host rejected by the destination policy`     | host not on `SMTP_ALLOWED_HOSTS`, or resolves to a private address | Add the provider host to the allow-list; never point production at localhost.                      |
| `security 'none' … only permitted in development`  | plaintext selected outside development                             | Use STARTTLS (587) or implicit TLS (465).                                                          |
| `TLS handshake failed`                             | expired/self-signed certificate or wrong hostname                  | Fix the certificate or use the hostname on the certificate. Certificate checks cannot be disabled. |
| `SMTP authentication failed`                       | wrong credentials, app password required, relay not enabled        | Regenerate SMTP credentials at the provider; for SendGrid the username is `apikey`.                |
| Test email accepted but not received               | landed in spam, or the provider sandbox restricts recipients       | Check `Authentication-Results`, publish SPF/DKIM/DMARC, move the account out of sandbox.           |
| `sender domain … is not an approved sender domain` | sender address outside the approved list                           | Add the domain after its DNS records pass the checklist.                                           |
