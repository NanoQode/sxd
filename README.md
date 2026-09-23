# SimplexD platform

Property services and oversight platform for Nigerians at home and abroad: public website
with a 50-market Nigeria explorer, customer portal, admin console, partner workspace,
versioned HTTP API and a background worker.

This repository is a deployable package: source, lockfile, SQL migrations, idempotent seed
import, Docker Compose stacks, provider adapters and operations documentation. Read
[`IMPLEMENTATION-STATUS.md`](./IMPLEMENTATION-STATUS.md) for an honest, requirement-by-requirement
account of what runs, what is tested and which external inputs remain.

## Layout

```text
apps/web/                 Next.js 16 app: public site, portal, admin, partner, /api/v1
apps/worker/              Background worker: durable job queue, outbox relay, schedules
packages/domain/          Pure logic: money, calculators, ranking, timelines, workflows, authz
packages/db/              Drizzle schema, migrations, RLS, seed importer, CLI commands
packages/ui/              Design tokens, themes (light/dark/system, reduced motion), components
packages/integrations/    Paystack, Termii, SMTP, Google Calendar/Meet, storage, scanner, secrets
packages/contracts/       Zod API contracts, error codes, OpenAPI generator
data/seed/                Reviewed 50-market research seed and its licence/notes
tests/e2e/                Playwright journeys and accessibility checks
deploy/                   Dockerfiles, production Compose stack, Caddy, database init
docs/                     Architecture decisions, operations, provider setup, guides
```

## Quick start (local)

Requirements: Node 22, pnpm 10, Docker (for PostgreSQL/PostGIS, Redis, MinIO, Mailpit).

```bash
pnpm install
cp .env.example .env            # fill AUTH_SECRET and SECRETS_MASTER_KEY (see comments)
docker compose up -d            # postgres+postgis, redis, minio, mailpit
pnpm db:migrate                 # applies packages/db/migrations with the owner role
pnpm db:seed                    # reference data + idempotent 50-market import
pnpm --filter @simplexd/web seed:demo   # development-only demo accounts
pnpm dev                        # web on http://localhost:3000
pnpm dev:worker                 # worker (jobs, outbox, schedules)
```

Create the first real administrator without a hardcoded password:

```bash
pnpm db:bootstrap-admin --email you@example.com
# prints a single-use setup link: /setup/<token>
```

## Commands

| Command                                              | What it does                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| `pnpm typecheck` / `pnpm lint` / `pnpm format:check` | Static checks across the workspace                                      |
| `pnpm test`                                          | Unit and integration tests (integration suites need the test database)  |
| `pnpm test:e2e`                                      | Playwright journeys against a running web app                           |
| `pnpm db:generate`                                   | Generate a migration after editing `packages/db/src/schema`             |
| `pnpm db:migrate`                                    | Apply pending migrations                                                |
| `pnpm db:seed`                                       | Seed reference data and import `data/seed/nigeria-50-markets.seed.json` |
| `pnpm db:import-markets [--dry-run] [file]`          | Re-run the market import with a preview option                          |
| `pnpm db:check-rls`                                  | Verify the runtime database role cannot bypass row-level security       |
| `pnpm openapi`                                       | Write `docs/api/openapi.json` from the route registry                   |
| `pnpm build`                                         | Production build of web (standalone) and worker (bundled)               |
| `pnpm backup` / `pnpm restore`                       | Database and object metadata backup/restore scripts                     |

## Deployment

See [`docs/operations/deployment.md`](./docs/operations/deployment.md) for the single-server
Docker Compose deployment with automatic HTTPS, the environment variables, secrets handling,
backups and rollback. Provider set-up (Paystack, Termii, SMTP, Google Workspace, map tiles,
object storage) is documented in [`docs/providers/`](./docs/providers/).

## Data and evidence policy

The market seed is geographically complete (50 markets, 36 states + FCT) but financially
incomplete by design. Observations keep their provenance and `rank_eligible: false` status;
financial ranking stays gated until validated local evidence meets the coverage policy.
See [`data/seed/DATA-RESEARCH-NOTES.md`](./data/seed/DATA-RESEARCH-NOTES.md).

## Licence

Proprietary. The geography subset is attributed under the MIT notice in
`data/seed/GEOGRAPHY-LICENSE.txt`.
