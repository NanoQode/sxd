#!/bin/bash
# Runs once when the PostGIS container initialises an empty data directory.
# Creates the runtime role (non-superuser, cannot bypass row-level security),
# enables required extensions and creates any extra databases (for tests).
set -euo pipefail

APP_PASSWORD="${SIMPLEXD_APP_PASSWORD:-simplexd_app_local}"
EXTRA_DBS="${SIMPLEXD_EXTRA_DATABASES:-}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'simplexd_app') THEN
    CREATE ROLE simplexd_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${APP_PASSWORD}';
  END IF;
END \$\$;
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
EOSQL

for db in $(echo "$EXTRA_DBS" | tr ',' ' '); do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -c "CREATE DATABASE \"$db\" OWNER \"$POSTGRES_USER\";"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<EOSQL
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
EOSQL
done
