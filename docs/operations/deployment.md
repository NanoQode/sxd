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

## 5. Health, logs and monitoring

- `GET /api/v1/health` returns database status; with `Authorization: Bearer $HEALTH_TOKEN`
  it also returns queue depth (pending/running/dead jobs, unpublished outbox events,
  oldest pending job age). Alert when `dead > 0`, `oldestPendingSeconds > 300` or
  `outboxUnpublished` keeps growing.
- Worker health: `http://worker:3100/healthz` inside the network.
- Logs are structured JSON on stdout (`docker compose logs -f web worker`); secrets are
  redacted at the logger. Set `SENTRY_DSN` to ship errors to Sentry.
- Admin → Integrations shows provider status (disconnected / configured, not verified /
  connected / degraded / expired / disabled), last successful check and sanitized logs.
- Suggested external monitors: uptime on `/api/v1/health`, certificate expiry (Caddy
  renews automatically), disk usage of the database volume, backup job success.

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
