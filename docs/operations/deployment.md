# Deployment guide

SimplexD ships as two container images (web and worker) plus PostgreSQL/PostGIS,
Redis, optional MinIO and ClamAV, fronted by Caddy for automatic HTTPS. The same images
run on any Docker-capable server, a container platform, or Kubernetes.

## 1. Server requirements

- Linux host with Docker Engine 24+ and Compose v2, 2 vCPU / 4 GB RAM minimum
  (8 GB recommended when running MinIO and ClamAV on the same host), 40 GB disk.
- A DNS A/AAAA record for the app domain pointing at the server; ports 80 and 443 open.
- Outbound HTTPS to Paystack, Termii, your SMTP provider, Google APIs and the map tile
  provider.

## 2. First deployment

```bash
git clone <repository> simplexd && cd simplexd
cp deploy/.env.production.example .env.production
# Fill in DOMAIN, ACME_EMAIL, APP_URL, passwords, AUTH_SECRET, SECRETS_MASTER_KEY,
# S3 settings (MinIO profile or managed bucket) and the map tile style URLs.
./deploy/deploy.sh
```

`deploy.sh` builds both images tagged with the git revision, starts the database and
cache, verifies that the runtime role cannot bypass row-level security
(`check-rls`), applies migrations with the owner role, rolls out web + worker + Caddy and
waits for the health endpoint.

Then seed reference data (idempotent) and create the first administrator:

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file .env.production run --rm seed
docker compose -f deploy/docker-compose.prod.yml --env-file .env.production run --rm bootstrap-admin --email you@example.com
```

The bootstrap command prints a single-use setup link. Open it, create the administrator
account and enrol an authenticator app; MFA is required for sensitive staff actions.
Demo seeding is refused in production.

Optional profiles:

```bash
# Local object storage (create the buckets afterwards with the MinIO console or mc)
docker compose -f deploy/docker-compose.prod.yml --env-file .env.production --profile storage up -d minio
# Upload scanning
docker compose -f deploy/docker-compose.prod.yml --env-file .env.production --profile scanner up -d clamav
```

## 3. Environment and secrets

- Application and worker read configuration from `.env.production` at runtime.
  Nothing secret is baked into images; the Dockerfile uses build-time placeholders only.
- Provider credentials (Paystack, Termii, SMTP, Google) are entered in
  Admin → Integrations and stored envelope-encrypted under `SECRETS_MASTER_KEY`.
  Rotate the master key by setting `SECRETS_PREVIOUS_MASTER_KEY(_ID)` to the old key,
  the new key as current, redeploying, then running the re-wrap job from
  Admin → Integrations → Secrets; remove the previous key after every record is re-wrapped.
- Two database roles: the owner (migrations, seeding, backups) and `simplexd_app`
  (runtime, no `BYPASSRLS`). Production refuses to start when the runtime role could
  bypass row-level security.
- `DATABASE_SSL=require` for managed PostgreSQL that enforces TLS.

## 4. Upgrades

```bash
git pull
./deploy/deploy.sh
```

Migrations are forward-only and applied before the new images start. Rolling back the
application (`./deploy/deploy.sh rollback`) restarts the previous image tags; database
migrations are not reverted automatically. Every migration in `packages/db/migrations`
is additive (new tables/columns) unless its header states otherwise, so the previous
release keeps working against a migrated database. Before an upgrade run a backup
(section 6).

Release checks in CI (`.github/workflows/ci.yml`, job `verify`): `pnpm audit --prod
--audit-level high` fails the build on high or critical advisories in production
dependencies, and `gitleaks/gitleaks-action` scans the full commit history of the push or
pull request for committed secrets (set the `GITLEAKS_LICENSE` repository secret when the
repository belongs to a GitHub organisation). The database suite also migrates a fresh
database from the previous schema snapshot (all migrations but the latest), inserts
representative rows, applies the latest migration and checks the rows survive, the new
tables have row-level security and the runtime role cannot bypass it, and that migrating
a clean database twice is a no-op (`packages/db/src/migrations.test.ts`).

## 5. Health, logs and monitoring

- `GET /api/v1/health` returns database status; with `Authorization: Bearer $HEALTH_TOKEN`
  it also returns queue depth (pending/running/dead jobs, unpublished outbox events,
  oldest pending job age). Alert when `dead > 0`, `oldestPendingSeconds > 300` or
  `outboxUnpublished` keeps growing.
- Worker health: `http://worker:3100/healthz` inside the network.
- Logs are structured JSON on stdout (`docker compose logs -f web worker`); authorization
  and cookie headers, passwords, secrets, tokens, API keys, OTPs and card numbers are
  redacted at the logger (shared paths in
  `packages/integrations/src/observability/redaction.ts`, covered by unit tests).
- Error tracking: see "Error tracking" below for what `SENTRY_DSN` enables and exactly
  what is sent.
- Admin → Integrations shows provider status (disconnected / configured, not verified /
  connected / degraded / expired / disabled), last successful check and sanitized logs.
- Suggested external monitors: uptime on `/api/v1/health`, certificate expiry (Caddy
  renews automatically), disk usage of the database volume, backup job success.

### Dead jobs and stuck outbox events

- **Dead jobs.** The worker retries a failing job with exponential backoff (30 s doubling,
  capped at 1 hour) until it reaches its `maxAttempts` (8 by default); a job with no
  registered handler or a non-retryable error goes straight to `dead`. Dead jobs stay in
  the `jobs` table with their sanitized last error; every attempt is kept in
  `job_failures`.
- **Stuck outbox events.** The relay routes unpublished outbox events into jobs. An event
  whose routing fails 20 times (`OUTBOX_MAX_ATTEMPTS`) is no longer claimed and stays
  unpublished until someone requeues it.
- **Admin → Jobs & Outbox** (`/admin/operations`) shows queue depth, dead (and failed,
  pending, running) jobs and stuck outbox events. Staff with `audit.read` or
  `platform.settings.manage` can read it. Payloads are never shown, because they can hold
  personal data; only their top-level field names are listed.
- **Retry** puts a dead job back to `pending` with attempts reset to 0, due now.
  **Requeue** resets an unpublished event's attempts to 0 and clears its error so the
  relay claims it again. Both require `platform.settings.manage` with a verified
  authenticator (MFA), ask for a reason and write an audit entry (`job.retried`,
  `outbox_event.requeued`). Other viewers see the lists read-only, with a link to
  `/admin/security/mfa`. The same actions are available at
  `POST /api/v1/admin/jobs/{jobId}/retry` and `POST /api/v1/admin/outbox/{eventId}/requeue`.
- Fix the cause before retrying (provider credentials under Admin → Integrations, a
  deployment with the missing handler, bad data). Otherwise the job runs out of attempts
  again and returns to `dead`.

### Operational alerts

The worker's `monitoring.snapshot` job (every 5 minutes) reads the operational tables,
evaluates the thresholds below and, when one is crossed, appends an `ops.alert` outbox
event that the notification pipeline delivers by e-mail and in-app to the staff roles
listed, using the generic `activity_update` template. Each alert key is raised at most
once per clock hour (the append-only audit log records `ops.alert_raised` for entity
`ops_alert <key>@<hour>` and is the dedupe ledger; concurrent workers are serialised with
an advisory lock). Messages carry counts and thresholds only, never personal data. Code:
`apps/worker/src/monitoring/`.

| Alert key           | Condition (default threshold)                                                                                                          | Recipients                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `queue.lag`         | Oldest due, unclaimed job waited ≥ `queueLagSeconds` (600 s); critical at 3× (1800 s)                                                  | super_admin                     |
| `jobs.dead`         | Dead-letter jobs ≥ `deadJobs` (1)                                                                                                      | super_admin                     |
| `outbox.stuck`      | Unpublished outbox events at `OUTBOX_MAX_ATTEMPTS` ≥ `stuckOutboxEvents` (1)                                                           | super_admin                     |
| `outbox.lag`        | Oldest relayable unpublished event ≥ `outboxLagSeconds` (600 s) old: the relay is not running (critical)                               | super_admin                     |
| `webhooks.payments` | Payment webhooks with an invalid signature or failed processing in the last hour ≥ `paymentWebhookFailuresPerHour` (5)                 | finance, super_admin            |
| `webhooks.sms`      | Termii webhooks rejected in the last hour ≥ `smsWebhookRejectionsPerHour` (5)                                                          | super_admin                     |
| `calendar.sync`     | Failed/conflicting event syncs for upcoming appointments + degraded or expired organiser connections ≥ `calendarSyncFailures` (1)      | operations_manager, super_admin |
| `storage.errors`    | Scan failures in the last hour + uploads waiting > `scanStuckMinutes` (30) for a scan + degraded storage/scanner ≥ `storageErrors` (1) | super_admin                     |
| `sms.balance_low`   | Last Termii balance recorded by the hourly health check < `smsBalanceMinimum` (5000); only live (non-dev) configurations count         | super_admin, finance            |
| `reviews.overdue`   | Reports in review longer than `reportReviewOverdueHours` (48 h) ≥ `overdueReportReviews` (1)                                           | operations_manager              |
| `sla.overdue`       | Open service requests and work orders past `sla_due_at` ≥ `overdueSlaItems` (1)                                                        | operations_manager              |

Defaults live in `apps/worker/src/monitoring/thresholds.ts` (`DEFAULT_THRESHOLDS`). To change
them without a deploy, store a partial JSON object in the `settings` table under the key
`monitoring.thresholds`, for example
`{"queueLagSeconds": 900, "smsBalanceMinimum": 10000, "deadJobs": null}`; `null` switches a
check off and invalid values are ignored. The health endpoint numbers above remain
available for external monitors; the alerts are the in-product counterpart.

The same scheduler also runs `market_data.expire_stale` (every 6 hours): it applies the
freshness policies (Admin → Market data → Freshness) to published observations and opens
one research task (category `evidence_refresh`) per observation per staleness period for
the data editors, without changing any published value. `market_data.invalidate_caches`
(on every `market_data.published` event) deletes the `cache:markets*` Redis keys as a
durable backstop to the web app's own invalidation.

### Error tracking

`SENTRY_DSN` (web and worker) enables a small, dependency-free reporter
(`packages/integrations/src/observability/error-reporting.ts`) that POSTs events to the
DSN's envelope endpoint (`https://<host>/api/<projectId>/envelope/` with the
`X-Sentry-Auth` header derived from the DSN's public key). No Sentry SDK is installed.

Reported: unhandled API route errors (HTTP 500 from the `route()` wrapper), errors Next.js
surfaces through `instrumentation.ts` (`onRequestError`: server components, server actions,
proxy), every failed worker job attempt (level `warning` while it will retry, `error` once
dead) and a worker start-up failure.

Each event contains: error type and message, a stack made of file paths, function names,
line and column numbers only (no source, no local variables; user home directories are
stripped), `release` = `APP_VERSION`, `environment` = `APP_ENV`, the source process
(`web`/`worker`), the correlation id, the route pattern with identifiers replaced by `:id`,
the HTTP method or job queue, and small tags (job type, attempt, outcome, router/route
type, React digest). Messages and tag values are scrubbed of API keys, bearer tokens, JWTs,
e-mail addresses, phone numbers, `password=`/`token=` pairs, query strings and long opaque
identifiers. Never sent: request bodies, headers, cookies, session or user identifiers,
payloads. Sending is rate limited (30 events per minute per process, plus the endpoint's
`Retry-After`), and failures never affect a response or a job: one warning is logged per
outage and the rest is silent. Without `SENTRY_DSN` nothing is sent.

## 6. Backups and restore

See `docs/operations/backup-restore.md`. Summary:

```bash
# nightly cron on the host (owner role URL)
MIGRATION_DATABASE_URL=postgres://simplexd_owner:...@127.0.0.1:5432/simplexd \
BACKUP_DIR=/var/backups/simplexd BACKUP_ENCRYPTION_RECIPIENT=age1... ./ops/backup/backup.sh
```

The database container archives WAL to `/var/lib/postgresql/wal_archive` (inside the
`db-data` volume). Copy that directory off-site together with nightly base backups to
achieve point-in-time recovery; without it, the recovery point is the last nightly dump
(24 hours), matching the initial service objective in the brief.

## 7. Scaling notes

- Web and worker are stateless; run several replicas behind a load balancer when needed.
  Redis is required for shared rate limiting across replicas.
- Worker queues can be split by setting `WORKER_QUEUES` per instance
  (e.g. `payments,calendar` on one, `notifications,media,default,maintenance` on another).
- Large uploads go directly to object storage through signed URLs; the app never proxies
  file bodies.

## 8. Cutover from the existing website

The live simplexd.co site is never switched automatically. The cutover runbook
(`docs/operations/cutover.md`) covers content migration, redirects, DNS TTL lowering,
smoke checks and rollback.
