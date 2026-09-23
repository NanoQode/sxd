# Backup and restore

## Objectives

| Objective            | Initial value                                                           | Notes                                                                           |
| -------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Recovery point (RPO) | 24 hours with nightly dumps; minutes with WAL archiving copied off-site | The database container archives WAL; ship `wal_archive` off-site to shorten RPO |
| Recovery time (RTO)  | 4 hours                                                                 | Restore drill below is timed each quarter                                       |
| Availability         | 99.5% monthly                                                           | Verify the hosting can meet it; single-server deployments have no redundancy    |

## What is backed up

- PostgreSQL logical dump (`pg_dump` custom format): all tables including audit events,
  ledger journals, provider events and encrypted secrets (ciphertext only; useless without
  `SECRETS_MASTER_KEY`, which must be stored separately in a password manager or KMS).
- Role definitions without passwords.
- `files-manifest.csv`: object keys, checksums and sizes so the private bucket can be
  reconciled. Object bodies live in the S3-compatible bucket; enable bucket versioning
  and replicate or snapshot the bucket separately (`mc mirror` for MinIO, provider
  replication for managed storage).
- `manifest.json`: counts and ledger totals used by restore verification.

Backups can be encrypted with `age` (`BACKUP_ENCRYPTION_RECIPIENT`) and uploaded to
`BACKUP_S3_URI`. Keep the age identity and the secrets master key outside the server.

## Restore drill (quarterly, before major upgrades)

1. Create an empty database: `createdb simplexd_restore -O simplexd_owner`.
2. Run `RESTORE_DATABASE_URL=postgres://simplexd_owner:...@host/simplexd_restore ./ops/backup/restore.sh <archive>`.
3. Confirm `[restore] VERIFIED`: user, organisation, project, invoice and audit counts
   match the manifest and ledger debits equal credits.
4. Point a staging web container at the restored database
   (`DATABASE_URL=...simplexd_restore`) and check: sign-in works for an administrator,
   a project page opens, an invoice shows the same balance, and a private file download
   resolves against the bucket (object references intact). Run the storage reconciliation
   (`pnpm --filter @simplexd/worker reconcile:storage`, see step 5 of the disaster recovery
   steps) against the restored database and bucket; it must report no missing objects.
5. Record the drill (date, archive, duration, issues) in the operations log.

### Drill log

| Date (UTC) | Source                                                                                                                          | Archive                                     | Result                                                                                                                                                                                                    | Notes                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-23 | Local development database (seeded: 15 demo users, 2 organisations, 50 markets, 16 observations, 17 audit events, 2 migrations) | `simplexd-20260923T020959Z.tar.gz` (148 KB) | `[restore] VERIFIED` in under one minute; every count and the ledger totals matched the manifest; `check-rls` on the restored database reported `rlsEnforced: true` with no warnings for the runtime role | Ledger and project counts were zero because no financial records existed yet; repeat the drill once sandbox payments have posted journals. Object storage reconciliation was not exercised (no files uploaded). |

## Disaster recovery steps

1. Provision a server, install Docker, clone the repository and restore `.env.production`
   and the secrets master key from the password manager.
2. Start the database: `docker compose -f deploy/docker-compose.prod.yml --env-file .env.production up -d db`.
3. Restore with `restore.sh` into the fresh `simplexd` database (it must be empty).
4. If WAL archives are available, perform point-in-time recovery according to the
   PostgreSQL documentation before starting the application.
5. Restore or re-point object storage, then reconcile it (read-only) with
   `pnpm --filter @simplexd/worker reconcile:storage` (or `node dist/cli/reconcile-storage.js`
   in the worker image, with `DATABASE_URL` and the `STORAGE_PROVIDER`/`S3_*` variables of the
   restored environment). It compares `file_objects` against the bucket listings and prints
   missing objects (row without object; exit code 1), orphan keys (object without a live row),
   objects lingering for removed rows and pending uploads. `--json` prints the full report and
   `--ignore-prefix <prefix>` skips keys the platform writes outside `file_objects`
   (`healthchecks/` by default). Nothing is deleted or modified; fix missing objects from the
   bucket backup or mark the rows, and review orphans before removing anything.
6. Run `./deploy/deploy.sh --no-build` (or build) and verify health, then re-enable DNS.

## Retention and privacy

- Backups contain personal data; apply the same access controls and retention policy as
  production (default 30 days of nightly archives, monthly archives kept 12 months).
- Deletion requests may require restricted retention of accounting/legal records; the
  data protection policy documents the outcome communicated to the person.
