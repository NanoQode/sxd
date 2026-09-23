# Implementation status

Living, requirement-by-requirement account of the SimplexD build against
`docs/brief/SIMPLEXD-CLAUDE-CODE-BUILD-BRIEF.md`. Status values:

- **implemented** – code exists, runs end to end and is exercised by automated tests.
- **implemented (untested live)** – code exists and passes contract/fixture tests, but the
  external provider has not been exercised with real sandbox credentials.
- **partial** – part of the requirement works; the gap is stated.
- **blocked by credentials/data** – cannot be completed without an external input.
- **outstanding** – not started.

Last updated: 2026-09-23 (Wave 0 complete; Waves 1–5 in progress). This file is refreshed at
each milestone.

## Release waves

| Wave | Deliverable                                                                                          | Status                                                                                                                                                             |
| ---- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | Repository, architecture decisions, schema, design tokens, auth, permissions, local services, CI     | implemented: reproducible install; migrations apply to a clean database; cross-organisation denial tests pass (21 database tests, 32 authorization/workflow tests) |
| 1    | Public website, 50 map points, evidence panels, calculators, saved scenarios, CMS, customer requests | in progress                                                                                                                                                        |
| 2    | Eight service workflows, portals, uploads, budgets, reports, approvals                               | outstanding                                                                                                                                                        |
| 3    | Payments/ledger, SMS, SMTP, Calendar/Meet, admin configuration, operational logs                     | outstanding                                                                                                                                                        |
| 4    | Tenders, procurement, rentals, maintenance, expansion templates                                      | outstanding                                                                                                                                                        |
| 5    | Accessibility, performance, security, migration, restore rehearsal, documentation, release           | outstanding                                                                                                                                                        |

## Section-by-section

### §1 Mission and delivery contract

- Repository initialised as a TypeScript modular monolith (`docs/adr/0001-architecture.md`). **implemented**
- `IMPLEMENTATION-STATUS.md` created and maintained. **implemented**
- Local/staging development with provider sandboxes; live domain never switched automatically. **implemented (policy)** — no cutover tooling touches simplexd.co.

### §2 Business baseline and positioning

- Eight services seeded with deliverables and completion evidence (`packages/db/src/seed/reference.ts`). **implemented**
- Editable price anchors (monitoring 150,000; diligence 100,000; architecture 250,000; management 75,000/month; virtual inspection 50,000; purchase support 1.5% = 150 bps; search 80,000; land by quotation) stored with basis, minimum scope, exclusions, effective date and `in_review` publication state requiring business review. **implemented**
- Purchase-support invoices require an agreed percentage basis and signed scope (`service_requests.fee_basis`, enforced in Wave 2 quote logic). **partial** (schema and rule defined; quote enforcement lands in Wave 2)
- No marketing statistics, testimonials, partner badges or project claims are carried over; brand assets flagged as unapproved (`settings.brand.assets_approved=false`). **implemented**
- Map coverage and service availability are separate fields (`markets.service_availability`, `service_coverage`). **implemented**

### §3 Product surfaces, routes and navigation

- Four surfaces on one identity system (better-auth sessions; staff roles, organisation memberships, partner profiles, tenant parties). **implemented (identity)**; surface pages: **in progress** (Wave 1–2).
- Public routes, portal routes, admin sections, partner workspace. **outstanding** (Waves 1–4).

### §4 UX, design, animation and themes

- Design tokens (warm neutrals, charcoal text, forest/teal primary, restrained gold) as CSS variables with light and dark values; brand assets pending owner approval. **implemented**
- Light/Dark/System with anonymous local persistence and authenticated profile persistence, first-paint script without flash, sun/moon/system control, admin defaults never overriding user choice. **implemented** (`packages/ui/src/theme`, `/api/v1/me/preferences`)
- Reduced motion (system + in-app preference) collapsing motion tokens. **implemented**
- Accessible primitives (Radix dialogs with focus trapping, labelled fields, error summaries, status = icon + words, 44 px touch targets, responsive table with mobile cards). **implemented (component library)**; page-level WCAG verification: Wave 5.
- Loading/empty/partial/stale/unauthorised/offline/success/failure states per module. **partial** (components exist; module coverage in Waves 1–4)

### §5 Public homepage and conversion journey

**outstanding** (Wave 1).

### §6 Homepage map and recommendation engine

- 6.1 MapLibre explorer, filters, compare tray, list fallback. **outstanding** (Wave 1)
- 6.2 Location panel and data badges (eight distinct badges implemented in UI). **partial**
- 6.3 Ranking contract: deterministic versioned engine with normalisation, confidence rubric, coverage gating (≥70%), local cost AND rent requirement, owner-occupier renormalisation, hard constraints, sponsored separation, stable ordering, explanations, snapshots. **implemented (engine)** — `packages/domain/src/ranking` (see test summary below); wiring to API/UI in Wave 1.
- 6.4 Financial calculators: development cost, area-rate vs BOQ (never summed), area conversion rejecting "plot", long-let economics (scheduled/effective income, NOI, gross/net yield with labelled denominator, cash-on-cash only with explicit equity, management fee never double charged, pre/after-tax, capex reserve separate, payback undefined when non-positive, no yield with zero denominator), short stays (explicit available nights), monthly phasing with completion delay, NPV/IRR with explicit inputs and non-unique IRR labelling, sensitivity grids and low/base/high sets. **implemented** — 71 tests including the brief's worked example (6m / 5.4m / 4.2m / 6% / 4.2%).
- 6.5 Three timeline systems: construction critical path with cycle rejection and missing-input honesty, bidding deadlines with authoritative server time and extensions, approvals with explicit day basis and no fabricated defaults. **implemented** — 52 tests.

### §7 Seed data and market-data administration

- Validated, idempotent import of the 50-market seed with provenance, immutable observations, versioned interpretations, editorial supplier leads, research tasks, demonstration timeline template and policy flags; re-import never overwrites human edits (conflicts reported); dry-run preview. **implemented** — `packages/db/src/seed`, 7 tests.
- Admin workflows (create/edit/archive/restore, move point, merge, CSV/JSON import preview, sources, approve/reject, compare revisions, publish/unpublish, rollback, policies). **outstanding** (Wave 1)
- Freshness policies and publication rules seeded as editable settings. **implemented (data)**

### §8 Eight core service modules

- Shared engagement state machine with permissions, reasons and billing effects. **implemented (domain)**; workflows and UI: **outstanding** (Wave 2).

### §9 Service expansions

- Twenty-three expansion services seeded as feature-flagged workflow templates sharing engagement/task/evidence/billing infrastructure; regulated features gated behind review-required flags (pooled investment, fractional ownership, wallets, escrow, lending, automated legal certification) and never enabled by templates. **implemented (registry/flags)**; workflow activation: Wave 4.

### §10 Customer, tenant and partner experiences

**outstanding** (Wave 2), identity groundwork implemented.

### §11 Admin console and permission model

- Granular permissions, role matrix with the brief's explicit exclusions, resource relationships (assignments, grants, memberships, tenants, partners), MFA gating for sensitive permissions, impersonation restrictions, separation of duties (own work, second approver). **implemented** — `packages/domain/src/authz`, 15 tests.
- Row-level security on 100+ organisation-scoped tables enforced for the runtime role; default deny without context; append-only audit/journal tables. **implemented** — 12 tests.
- Admin navigation and tools. **outstanding** (Waves 1–4)
- Service setup (`/admin/services`): price anchors as append-only revisions published by a different pricing manager with MFA (public site reads published values in force today only), quotation templates with quote prefill, report templates (one active per kind, seeded defaults), document requirements (customer "Documents we need", public "What you'll need", sensitive items never public), SLA policy editor. Portfolio analytics (`/admin/analytics`) derived from records with reconciling CSV exports. **implemented** — `apps/web/src/server/admin/configuration`, `apps/web/src/server/admin/analytics`, 17 integration + 9 unit tests; see `docs/workflows/admin-configuration.md`.
- Support escalation: tickets are `support_ticket` conversations; no priority/escalation model exists (documented gap, no schema added).
- Support impersonation flow with reason, banner, expiry. **outstanding** (flag exists; Wave 2)

### §12 Payment gateway and accounting

- Ledger schema with balanced-journal enforcement (deferred constraint trigger), append-only lines, chart of accounts separating receivables, revenue, gateway clearing, fees, refunds, rent liabilities and owner distributions. **implemented (schema/ledger rules)**
- Paystack adapter, verification, HMAC-SHA512 webhook, dedupe, reconciliation, refunds, chargebacks. **outstanding** (Wave 3)

### §13 SMS provider configuration

**outstanding** (Wave 3). Research note: developers.termii.com was unreachable from the build environment; adapter will follow official snippets and must be verified against the sandbox.

### §14 SMTP configuration and notifications

- Transactional outbox with idempotent jobs, retry/backoff, dead-letter and admin retry. **implemented** (`packages/db/src/jobs.ts`, worker runner)
- SSRF destination policy for admin-configured hosts. **implemented** (4 tests)
- SMTP adapter, templates rendering, delivery states, digests, quiet hours. **outstanding** (Wave 3)

### §15 Google Calendar and Meet

- Slot exclusion constraint (`slot_reservations`) proven with tests. **implemented (database)**
- OAuth, free/busy, event/Meet creation, push channels, sync. **outstanding** (Wave 3). Research verified against Google's Calendar v3 discovery document and official Node library.

### §16 Integration administration and secrets

- Envelope encryption (AES-256-GCM, per-secret DEK, master key rotation window, fingerprints, masked presence). **implemented** — 5 tests.
- Integration states, save/test/activate distinction, sanitized logs. **outstanding** (Wave 3)

### §17 Technical architecture

- Next.js 16 App Router, separate worker, PostgreSQL 16 + PostGIS 3.4, Redis, Postgres-backed durable queue with outbox, S3-compatible storage adapter interface, better-auth for identity/MFA/organisations, pinned versions and committed lockfile. **implemented**
- Server-authoritative permissions and transitions; validation; correlation ids; sanitized logging; RLS context per transaction. **implemented (framework)**

### §18 Data model and APIs

- Entities for identity, geography (PostGIS), intelligence, CRM/services, property, project, commercial, rental, finance, communications and platform (163 tables). **implemented**
- OpenAPI registry with error envelope and pagination contracts. **implemented (generator)**; route coverage grows per wave.

### §19 Security, privacy and reliability

- CSP with per-request nonces, security headers, HttpOnly/SameSite cookies, rate limiting on auth endpoints, secrets never shipped to the browser, production refusal of dev adapters and insecure SMTP. **implemented (baseline)**
- Upload policy (blocked SVG/HTML/scripts, allow-list, size), quarantine bucket. **implemented (policy)**; scanning pipeline: Wave 2.
- Backups, restore drill, monitoring. **outstanding** (Wave 5)

### §20 CMS, search, migration and SEO

**outstanding** (Wave 1 for CMS; Wave 5 for migration/redirects).

### §21 Acceptance scenarios

| #   | Scenario                                                                                                           | Status                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| 1   | Visitor filters 50 locations, compares four, saves scenario, reload preserves it                                   | outstanding                                                     |
| 2   | Data editor adds 51st market, imports observations, approver publishes, rollback audited                           | partial (import/conflict logic tested; admin UI outstanding)    |
| 3   | Customer requests diligence, accepts versioned quote, pays in sandbox, gets reviewed report; other customer denied | outstanding (isolation proven at DB layer)                      |
| 4   | Contractor bid before closing; no revisions after; no competitor visibility; award only when published             | outstanding (RLS policies for bids/awards implemented)          |
| 5   | Change order cannot alter approved budget without required approvals                                               | outstanding (state machine implemented)                         |
| 6   | Duplicate/delayed/reordered payment events never double-allocate; invalid signatures rejected                      | outstanding (dedupe keys and append-only allocations in schema) |
| 7   | Two users compete for one slot; only one wins; Google failure visible/retryable; DST-safe                          | partial (exclusion constraint proven)                           |
| 8   | Admin configures SMTP/SMS, test sends, rotates a secret never exposed                                              | outstanding (secret storage implemented)                        |
| 9   | Owner statement accurate; tenant sees only own obligations; maintenance flow                                       | outstanding                                                     |
| 10  | Inspector offline resume without duplication or leaks                                                              | outstanding (offline client ids in schema)                      |
| 11  | All surfaces in light/dark/system, reduced motion, keyboard, map fallback at 360 px                                | partial (theming implemented)                                   |
| 12  | Unsupported/infected files unavailable; signed download expires; revoked membership blocks                         | outstanding                                                     |
| 13  | Backup restore reproduces state                                                                                    | outstanding                                                     |
| 14  | No dead controls or fake dashboards                                                                                | in progress                                                     |

## Test results (latest run)

| Suite                                                                                               | Result                          |
| --------------------------------------------------------------------------------------------------- | ------------------------------- |
| `packages/db` (RLS isolation, append-only, ledger balance, slot exclusion, seed import/idempotency) | 21 passed                       |
| `packages/domain` money/authz/workflow                                                              | 32 passed                       |
| `packages/domain` finance calculators                                                               | 71 passed                       |
| `packages/domain` timelines                                                                         | 52 passed                       |
| `packages/domain` ranking                                                                           | pending (agent run in progress) |
| `packages/integrations` secrets + SSRF                                                              | pending run                     |

## External inputs still required (not blocking implementation)

- Approved brand assets and copy; existing site content export and image rights.
- Hosting, domain, database, object storage and DNS accounts.
- Paystack merchant approval and test/live keys; enabled channels.
- Termii account, approved sender ID, API key, webhook secret.
- SMTP account and SPF/DKIM/DMARC records.
- Google Cloud OAuth client, organiser consent, verified domain for push notifications.
- Licensed map tile account (MapTiler or equivalent) and optional geocoding.
- Operational staff/partners, locally reviewed prices and data publication rights.

## Environment note

The official documentation sites for Paystack, Termii and Google Calendar were blocked by the
build environment's egress policy. Provider contracts were verified from Paystack's official
OpenAPI specification and documentation-snippet repositories, Google's Calendar v3 discovery
document and official Node client, and Termii's official snippets (with unverified items
flagged in `docs/providers/`). Live sandbox verification remains a launch task.
