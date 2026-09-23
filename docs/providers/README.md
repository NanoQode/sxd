# Provider setup guides — index

Every external provider is configured in **Admin → Integrations** (`/admin/integrations`), never through code changes. Detailed guides per provider sit next to this file; this index tells the business owner what to supply, where to enter it, how to test, how to activate and how to rotate.

Build brief: §12–§16 and acceptance scenario 8. Implementation: `apps/web/src/server/integrations/`, `apps/worker/src/handlers/integrations.ts`, workflow notes in [docs/workflows/integrations.md](../workflows/integrations.md).

## The three steps that are always separate

| Step         | What it does                                                                                                                                                                 | State afterwards                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Save**     | Writes a _new version_ of the settings. Secrets you enter are envelope-encrypted immediately; secrets you leave blank are carried over unchanged.                            | `Saved, not tested` — nothing changes at runtime                                            |
| **Test**     | Runs the real provider check against that version (Paystack credential check, Termii balance + sender ID, SMTP handshake + DNS, S3 head, ClamAV ping, map style validation). | The honest result is recorded on the version; still nothing changes at runtime              |
| **Activate** | Switches the runtime to that version. Requires a passed test on that exact version; forcing without one needs a reason and is shown as `Active, not verified`.               | `Connected` (or `Active, not verified` when forced). The previous active version is retired |

Additional states: `Degraded` (hourly health check failed), `Expired` (the provider rejected the credential), `Disabled` (switched off by an administrator with a reason).

Test and live environments are configured separately and never mixed: a Paystack `sk_live_…` key is refused in the **test** environment and vice-versa. The runtime reads `live` when `APP_ENV=production` and `test` otherwise.

## What each provider needs

| Provider         | Owner supplies                                                                               | Non-secret settings                                                                | Write-only secrets                                 | Test does                                                          | Guide                                        |
| ---------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------- |
| Paystack         | Test + live key pairs from the Paystack dashboard; webhook URL pasted into Paystack          | currency, enabled payment purposes, checkout channels                              | `secretKey`, `publicKey`, optional `webhookSecret` | Read-only credential check; key prefix must match the environment  | [paystack.md](./paystack.md)                 |
| Termii           | API key, account base URL, an **approved** sender ID; delivery-report URL pasted into Termii | base URL, sender ID, purposes, daily limit, spend cap, unit cost, test recipient   | `apiKey`, optional `webhookSecret`                 | Balance + sender-ID approval lookup                                | [termii.md](./termii.md)                     |
| SMTP             | Host/port/security from the mail provider, a sender address on a domain with SPF/DKIM/DMARC  | host, port, security, username, sender, reply-to, approved domains, test recipient | `password`                                         | TLS handshake + AUTH, SPF/DKIM/DMARC presence                      | [smtp.md](./smtp.md)                         |
| Google Workspace | OAuth client (web application) with the redirect URI shown on the page                       | client ID, calendar, working hours, consultation length, buffers                   | `clientSecret`                                     | Validates the client and reports organiser-grant health separately | [google-workspace.md](./google-workspace.md) |
| Object storage   | S3/MinIO/R2 endpoint, region, bucket names; credentials or an instance role                  | region, endpoint, path style, bucket names, signed-URL lifetime                    | `accessKeyId`, `secretAccessKey`                   | HEAD on a probe key in the private bucket                          | [storage.md](./storage.md)                   |
| Malware scanner  | A reachable `clamd`                                                                          | host, port, timeout                                                                | —                                                  | `PING`/`VERSION`                                                   | [storage.md](./storage.md#5-clamav-profile)  |
| Maps             | A licensed tile provider key restricted to the site origin                                   | style URLs (light/dark), attribution, geocoding provider                           | optional server-side `apiKey`                      | Refuses community/demo tile hosts and non-https URLs               | [maps.md](./maps.md)                         |

A **development adapter** exists for each provider (labelled in the UI and in every test result). It is refused when `APP_ENV=production`.

## Where to enter it

1. Sign in with a staff account that has `integrations.manage` and a **verified authenticator** (saving, activating, disabling and rotating require MFA; Paystack secrets additionally need `integrations.payment_credentials.manage`).
2. Open **Admin → Integrations**, pick the provider, choose the **environment** (test or live).
3. Fill the settings, paste the secrets, press **Save as new version**.
4. Press **Test connection** and read the result. A green result from a development adapter says so explicitly.
5. Press **Activate**. The button is disabled until the version has a passed test.

## How to rotate a secret

1. Create the new credential at the provider (keep the old one valid for a moment).
2. On the provider page press **Rotate secret…**, pick the field, paste the new value, give a reason.
3. The platform stores the new value as a fresh encrypted record, **retires the old record**, and creates a new configuration version with the other secrets unchanged. If the rotated version was active, the new version is tested immediately and activated only when the test passes; otherwise the old version is marked `Expired` and the page tells you what failed.
4. Revoke the old credential at the provider.

The old value is never shown or returned by any API; only the fingerprint (first 8 hex characters of a SHA-256) changes, which is how you can confirm the rotation took effect.

## Rotating the master key (envelope encryption)

Secrets are stored as AES-256-GCM ciphertext whose per-secret data key is wrapped by the master key from `SECRETS_MASTER_KEY` / `SECRETS_MASTER_KEY_ID`.

1. Set the new key as `SECRETS_MASTER_KEY` (+ a new `SECRETS_MASTER_KEY_ID`) and move the old one to `SECRETS_PREVIOUS_MASTER_KEY` / `SECRETS_PREVIOUS_MASTER_KEY_ID`. Restart web and worker.
2. Admin → Integrations shows how many secrets are still wrapped by the previous key. Press **Re-wrap secrets**: the worker job `integrations.rewrap_secrets` re-wraps every non-retired secret in memory and reports counts to the integration log.
3. When the count reaches zero, remove the previous key from the environment.

## Monitoring

The worker re-runs every active configuration's check hourly (`integrations.health_check`). A failure moves the version to `Degraded` (or `Expired` when the provider rejected the credential) and emits one `integration.degraded` outbox event per transition; a later success moves it back to `Connected`. Sanitized entries appear in the provider's log table; secret values are scrubbed before anything is written.
