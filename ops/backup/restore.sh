#!/usr/bin/env bash
# Restores a SimplexD backup archive into a database and verifies it.
#
# Usage:  RESTORE_DATABASE_URL=postgres://owner:pw@host/simplexd_restore ./ops/backup/restore.sh /path/simplexd-<stamp>.tar.gz[.age]
#
# The target database must exist and be EMPTY (create it fresh). PostGIS and the
# other extensions must be installable by the connecting role. After the
# restore, the script compares record counts and ledger totals against the
# manifest and prints a verification report. Use this both for disaster
# recovery and for the periodic restore drill (docs/operations/backup-restore.md).
set -euo pipefail

archive="${1:?path to backup archive}"
: "${RESTORE_DATABASE_URL:?set RESTORE_DATABASE_URL (owner role of an empty database)}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if [[ "$archive" == *.age ]]; then
  : "${BACKUP_AGE_IDENTITY:?set BACKUP_AGE_IDENTITY (path to the age private key)}"
  age -d -i "$BACKUP_AGE_IDENTITY" -o "$work/archive.tar.gz" "$archive"
  archive="$work/archive.tar.gz"
fi
tar -C "$work" -xzf "$archive"

echo "[restore] verifying archive checksums"
expected=$(python3 -c "import json;print(json.load(open('$work/manifest.json'))['checksums']['db.dump'])")
actual=$(sha256sum "$work/db.dump" | cut -d' ' -f1)
[[ "$expected" == "$actual" ]] || { echo "checksum mismatch for db.dump" >&2; exit 1; }

tables=$(psql "$RESTORE_DATABASE_URL" -Atc "select count(*) from pg_tables where schemaname='public' and tablename <> 'spatial_ref_sys'")
if [[ "$tables" != "0" ]]; then
  echo "target database is not empty ($tables tables); refusing to restore over data" >&2
  exit 1
fi

echo "[restore] creating extensions"
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
SQL

echo "[restore] restoring database"
pg_restore --no-owner --no-privileges --exit-on-error --dbname "$RESTORE_DATABASE_URL" "$work/db.dump"

echo "[restore] re-applying runtime grants (roles are not part of the dump)"
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'simplexd_app') THEN
    GRANT USAGE ON SCHEMA public, app TO simplexd_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO simplexd_app;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO simplexd_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO simplexd_app;
  END IF;
END $$;
SQL

echo "[restore] verifying counts and ledger balance against the manifest"
actual_counts=$(psql "$RESTORE_DATABASE_URL" -Atc "
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
python3 - "$work/manifest.json" "$actual_counts" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1]))["counts"]
actual = json.loads(sys.argv[2])
ok = True
for key, expected in manifest.items():
    got = actual.get(key)
    status = "ok" if str(got) == str(expected) else "MISMATCH"
    if status != "ok": ok = False
    print(f"  {key:16} expected={expected:<12} restored={got:<12} {status}")
if actual.get("journal_debits") != actual.get("journal_credits"):
    print("  ledger is NOT balanced after restore"); ok = False
else:
    print("  ledger balanced: debits == credits")
print("[restore] VERIFIED" if ok else "[restore] VERIFICATION FAILED")
sys.exit(0 if ok else 1)
PY
echo "[restore] object storage: reconcile files-manifest.csv against the bucket (see docs/operations/backup-restore.md)"
