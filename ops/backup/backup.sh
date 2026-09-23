#!/usr/bin/env bash
# Database and object-metadata backup for SimplexD.
#
# Produces a timestamped, optionally encrypted archive containing:
#   - db.dump          pg_dump custom format (schema + data, including audit and ledger)
#   - globals.sql      roles (without passwords when --no-role-passwords is supported)
#   - files-manifest.csv  file_objects metadata so object storage can be reconciled
#   - manifest.json    versions, counts and checksums used by restore verification
#
# Usage:  BACKUP_DIR=/var/backups/simplexd MIGRATION_DATABASE_URL=... ./ops/backup/backup.sh
# Optional: BACKUP_ENCRYPTION_RECIPIENT (age public key), BACKUP_S3_URI (s3://bucket/prefix, needs aws or mc),
#           BACKUP_RETENTION_DAYS (default 30).
set -euo pipefail

: "${MIGRATION_DATABASE_URL:?set MIGRATION_DATABASE_URL (owner role)}"
BACKUP_DIR="${BACKUP_DIR:-./var/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$BACKUP_DIR"

echo "[backup] dumping database"
pg_dump --format=custom --no-owner --no-privileges --file "$work/db.dump" "$MIGRATION_DATABASE_URL"
pg_dumpall --globals-only --no-role-passwords --dbname "$MIGRATION_DATABASE_URL" > "$work/globals.sql" 2>/dev/null || true

echo "[backup] exporting object metadata"
psql "$MIGRATION_DATABASE_URL" -Atc "COPY (SELECT id, bucket, storage_key, size_bytes, checksum_sha256, status, organization_id, entity_type, entity_id, created_at FROM file_objects WHERE deleted_at IS NULL) TO STDOUT WITH CSV HEADER" > "$work/files-manifest.csv"

echo "[backup] writing manifest"
counts=$(psql "$MIGRATION_DATABASE_URL" -Atc "
  SELECT json_build_object(
    'users', (SELECT count(*) FROM \"user\"),
    'organizations', (SELECT count(*) FROM organization),
    'markets', (SELECT count(*) FROM markets),
    'observations', (SELECT count(*) FROM observations),
    'projects', (SELECT count(*) FROM projects),
    'invoices', (SELECT count(*) FROM invoices),
    'journals', (SELECT count(*) FROM journals),
    'journal_debits', (SELECT coalesce(sum(debit_kobo),0)::text FROM journal_lines),
    'journal_credits', (SELECT coalesce(sum(credit_kobo),0)::text FROM journal_lines),
    'file_objects', (SELECT count(*) FROM file_objects),
    'audit_events', (SELECT count(*) FROM audit_events),
    'migrations', (SELECT count(*) FROM drizzle.schema_migrations)
  )::text")
cat > "$work/manifest.json" <<JSON
{
  "createdAt": "$stamp",
  "tool": "ops/backup/backup.sh",
  "postgresVersion": "$(psql "$MIGRATION_DATABASE_URL" -Atc 'show server_version')",
  "counts": $counts,
  "checksums": {
    "db.dump": "$(sha256sum "$work/db.dump" | cut -d' ' -f1)",
    "files-manifest.csv": "$(sha256sum "$work/files-manifest.csv" | cut -d' ' -f1)"
  }
}
JSON

archive="$BACKUP_DIR/simplexd-$stamp.tar.gz"
tar -C "$work" -czf "$archive" db.dump globals.sql files-manifest.csv manifest.json
if [[ -n "${BACKUP_ENCRYPTION_RECIPIENT:-}" ]]; then
  if ! command -v age >/dev/null; then echo "age is required for encryption" >&2; exit 1; fi
  age -r "$BACKUP_ENCRYPTION_RECIPIENT" -o "$archive.age" "$archive"
  rm -f "$archive"
  archive="$archive.age"
fi
echo "[backup] wrote $archive ($(du -h "$archive" | cut -f1))"

if [[ -n "${BACKUP_S3_URI:-}" ]]; then
  if command -v aws >/dev/null; then
    aws s3 cp "$archive" "$BACKUP_S3_URI/$(basename "$archive")"
  elif command -v mc >/dev/null; then
    mc cp "$archive" "$BACKUP_S3_URI/$(basename "$archive")"
  else
    echo "neither aws nor mc found; archive kept locally only" >&2
  fi
fi

echo "[backup] pruning archives older than $RETENTION_DAYS days"
find "$BACKUP_DIR" -name 'simplexd-*.tar.gz*' -mtime "+$RETENTION_DAYS" -delete
echo "[backup] done"
