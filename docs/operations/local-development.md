# Local development

## Prerequisites

- Node.js 22 (see `.node-version`), pnpm 10 (`corepack enable` works).
- Docker with Compose v2 for dependencies, or local PostgreSQL 16 + PostGIS 3.4, Redis 7.
- Chromium for Playwright (`pnpm --filter @simplexd/e2e exec playwright install chromium`).

## Dependencies with Docker Compose

`docker-compose.yml` starts PostgreSQL/PostGIS (with the `simplexd_app` runtime role and the
`simplexd_test` database created by `deploy/db/init/20-roles-and-extensions.sh`), Redis, MinIO
(private buckets) and Mailpit (development SMTP sink at http://localhost:8025).

```bash
docker compose up -d
```

## Without Docker

Create the roles and databases yourself (the migration needs the PostGIS, btree_gist,
pgcrypto and pg_trgm extensions; PostGIS needs a superuser to install):

```sql
CREATE ROLE simplexd_owner LOGIN SUPERUSER PASSWORD 'simplexd_owner_local';
CREATE ROLE simplexd_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'simplexd_app_local';
CREATE DATABASE simplexd_dev OWNER simplexd_owner;
CREATE DATABASE simplexd_test OWNER simplexd_owner;
\c simplexd_dev
CREATE EXTENSION postgis; CREATE EXTENSION btree_gist; CREATE EXTENSION pgcrypto; CREATE EXTENSION pg_trgm;
\c simplexd_test
CREATE EXTENSION postgis; CREATE EXTENSION btree_gist; CREATE EXTENSION pgcrypto; CREATE EXTENSION pg_trgm;
```

## Environment

Copy `.env.example` to `.env`. Generate secrets:

```bash
openssl rand -base64 48   # AUTH_SECRET
openssl rand -base64 32   # SECRETS_MASTER_KEY
```

Two database URLs are used on purpose: `MIGRATION_DATABASE_URL` (owner) for migrations,
seeding and bootstrap commands, and `DATABASE_URL` (`simplexd_app`) for the application so
row-level security is enforced. `pnpm db:check-rls` reports whether the runtime role can
bypass RLS.

## Migrate, seed, run

```bash
pnpm db:migrate
pnpm db:seed                          # reference data + 50 markets (idempotent)
pnpm --filter @simplexd/web seed:demo # demo accounts (refused outside development/test)
pnpm dev                              # http://localhost:3000
pnpm dev:worker                       # http://localhost:3100/healthz
```

Demo accounts (password `DemoPassword-2026!`): `admin@`, `ops@`, `pm@`, `inspector@`,
`finance@`, `data-editor@`, `data-approver@`, `content@`, `support@`, `contractor@`,
`surveyor@`, `owner@`, `member@`, `other-owner@`, `tenant@` all at `demo.simplexd.local`.

Development adapters are used whenever a provider is not configured: payments (`dev`),
SMS (`dev`), mail (Mailpit or `dev`), Google Calendar (`dev`), storage (`local-dev`) and the
malware scanner (`dev`, which flags the EICAR test string). Production refuses them.

## Tests

```bash
pnpm test                 # all Vitest projects; integration suites migrate simplexd_test first
pnpm test:unit            # domain, contracts, integrations, ui, web-unit
pnpm test:integration     # db, web-integration, worker (need the test database)
pnpm test:e2e             # Playwright against a running/built web app
```

Integration tests truncate tables in `simplexd_test`; never point `TEST_DATABASE_URL` at a
database you care about.

## Schema changes

1. Edit `packages/db/src/schema/*.ts`.
2. `pnpm db:generate` creates a SQL migration in `packages/db/migrations`.
3. Hand-written policy or trigger changes go in a custom migration
   (`pnpm --filter @simplexd/db exec drizzle-kit generate --custom --name <name>`).
4. `pnpm db:migrate` and run `pnpm test:integration`.

Migrations are append-only; never edit an applied migration.
