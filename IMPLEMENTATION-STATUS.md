# Implementation status

Requirement-by-requirement account of the SimplexD build against
`docs/brief/SIMPLEXD-CLAUDE-CODE-BUILD-BRIEF.md`, written from the code and the test runs
of the release candidate. Status values:

- **implemented** – code runs end to end with persistence, authorization and validation, and
  automated tests exercise it.
- **implemented (development adapter)** – the workflow runs, but the external provider has only
  been exercised through the labelled development adapter and contract fixtures; no real
  sandbox credentials have been used.
- **partial** – part of the requirement works; the gap is stated.
- **not offered** – deliberately left out; the reason is stated.

Last updated: 2026-09-23 (release candidate). Environment: Node 22, pnpm 10.33, Next.js 16.3,
PostgreSQL 16 + PostGIS 3.4, Redis 7. Everything below was verified in a development container:
no real payment, SMS, email, calendar, storage or map-tile account was available.

## What runs

- Public website with the 50-market Nigeria explorer (filters, comparison of up to four markets,
  evidence panels, calculators, saved scenarios), services, pricing, locations, listings,
  resources, policies, consultation and listing inquiries, CMS-managed banners, navigation,
  goal paths and location introductions.
- Customer portal: onboarding, organisations and household members, service requests for all
  eight core services, versioned quotes and acceptance, invoices and payment, properties, leases
  and statements, projects (budgets, schedules, change orders, reports, media, defects), due
  diligence records, property search and purchase representation, listings, documents,
  appointments, messages, notifications, scenarios, settings with phone verification.
- Tenant portal: own lease, balances, receipts, tickets with photos, appointments, notices.
- Partner workspace: invited tenders and bids, assignments, field visits with offline capture,
  reports with reviewer selection, RFQs and orders with discrepancy replies, evidence, availability,
  conversations, invoices, assigned diligence items.
- Admin console: overview, CRM/leads, customers, properties, projects, service requests,
  assignments, reports, tenders, procurement, rentals/maintenance, finance (invoices, journals,
  reconciliation, refunds, payouts, partner invoices, exports), appointments, messages, market data
  (markets, observations, sources, imports, exports, ranking/freshness/data policies), content
  (pages, media, redirects with CSV import), listings moderation, partners, integrations,
  communications (templates, test sends, delivery log, suppressions), service setup (price anchors,
  quotation/report templates, document requirements, SLA policies), portfolio analytics,
  settings, feature flags, access, jobs & outbox, audit.
- API: 488 route handlers, 485 documented in `docs/api/openapi.json`; worker with a durable job
  queue, outbox relay, schedules, monitoring alerts and operational CLIs.
- Database: 166 tables, 157 with row-level security, 8 migrations, idempotent reference and
  50-market seed, migration test against the previous schema snapshot.

## Release waves

| Wave | Deliverable                                                                                          | Status                                                                                                                                                             |
| ---- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | Repository, architecture decisions, schema, design tokens, auth, permissions, local services, CI     | implemented: reproducible install, migrations apply to a clean database and to the previous snapshot, cross-organisation denial tests pass                         |
| 1    | Public website, 50 map points, evidence panels, calculators, saved scenarios, CMS, customer requests | implemented: anonymous exploration → account → saved scenario → service request (Playwright scenario 1); unknown data never produces a price                       |
| 2    | Eight service workflows, portals, uploads, budgets, reports, approvals                               | implemented: a complete engagement runs through the HTTP API without touching the database (Playwright engagement journey); every core service has its own records |
| 3    | Payments/ledger, SMS, SMTP, Calendar/Meet, admin configuration, operational logs                     | implemented (development adapters): failure/retry paths tested with fixtures and dev adapters; real sandbox journeys still to be run with the owner's credentials  |
| 4    | Tenders, procurement, rentals, maintenance, expansion workflow templates                             | implemented: end-to-end journeys and permission checks per activated module                                                                                        |
| 5    | Accessibility, performance, security, migration, restore rehearsal, documentation, release           | implemented: axe checks on every surface at desktop and 360 px, load check, security fixes, redirect/inventory tooling, restore drill, this report                 |

## Section-by-section

### §1 Mission and delivery contract

- TypeScript modular monolith (`docs/adr/0001-architecture.md`), this status file, provider
  sandboxes documented, live simplexd.co never switched automatically
  (`docs/operations/cutover.md`). **implemented**

### §2 Business baseline and positioning

- Eight core services seeded with deliverables and completion evidence; price anchors are editable
  revisions with basis, minimum scope, exclusions and effective date; publication requires a
  different manager with MFA (separation of duties); public pages only ever show published values
  in force today (`apps/web/src/server/admin/configuration/pricing.ts`,
  `pricing.int.test.ts`). **implemented**
- Purchase-support fee: a percentage-basis quote is refused unless an agreed basis amount, a clean
  signed-scope file and a stated scope are recorded; the invoice derives from the agreed basis
  only (`packages/finance/src/engagements/fee-basis.ts`, `percentage-fee.test.ts`,
  `purchase.int.test.ts`). **implemented**
- No marketing statistics, testimonials, partner badges or project claims carried over; brand
  assets flagged unapproved (`settings.brand.assets_approved=false`); customer stories render only
  when approved in the CMS. **implemented**
- Map coverage and service availability are separate fields, shown with distinct badges.
  **implemented**

### §3 Product surfaces, routes and navigation

- Public, portal, admin, partner and tenant surfaces on one identity system; all public and portal
  routes from the brief plus explorer, listings, searches, tenant and partner routes (182 pages).
  Admin navigation carries the brief's twenty sections plus Listings, Communications, Service
  Setup, Portfolio Analytics and Jobs & Outbox (see "Decisions to confirm"). **implemented**
- Header mega-menu, sticky header, action bar, global search dialog, footer; navigation editable
  in the CMS with defaults as fallback. **implemented**

### §4 UX, design, animation and themes

- Design tokens with light and dark values verified for WCAG AA text contrast; light/dark/system
  with first-paint script, anonymous local persistence and profile persistence; reduced motion from
  system or in-app preference; accessible primitives (labelled fields, focus management, status =
  icon + words, 44 px targets, responsive tables that become cards). **implemented**
- Playwright axe checks (WCAG 2.2 AA tags, serious/critical) on public pages, dark theme, and each
  signed-in workspace at desktop and 360 px, with no horizontal page scroll
  (`tests/e2e/specs/journeys.spec.ts`). **implemented**
- Loading/empty/partial/stale/unauthorised/offline/success/failure states per module; the
  partner workspace has no remaining "not available" notice for a missing feature. **implemented**

### §5 Public homepage and conversion journey

- Homepage order as specified: value proposition and two actions, explorer with static outline
  before the map bundle, eight service cards with published price anchors, goal paths (CMS or
  defaults), how it works, approved case studies, sample reports, evidence standards, customer
  stories only when approved, FAQs, consultation form, footer. **implemented**
- Anonymous exploration and estimates; account required to save a plan, share, request local
  verification or start a service (`core.anonymous_scenarios` seeds off; the chosen action
  resumes pre-filled after sign-in); selected cities, filters, budget and scenario carried into the
  consultation and quote request; consent-aware analytics
  (`apps/web/src/lib/explorer/account-gate.ts`, `consultation.int.test.ts`,
  `scenario-1.spec.ts`). **implemented**

### §6 Homepage map and recommendation engine

- 6.1 MapLibre explorer with clustering, filters, list/map switch, comparison tray, mobile sheet;
  the licensed tile provider is not configured in this environment, so the map shows the honest
  "not configured" panel and the results list carries the full functionality (tested in
  `scenario-1.spec.ts`). **implemented; tile account outstanding**
- 6.2 Location panel with the eight evidence badges, statewide-context labelling, real open tender
  opportunities scoped by the caller's rights, dated verified supplier quotes recorded when
  purchase orders are issued (`server/markets/tenders.ts`, `procurement/supplier-quotes.ts`).
  **implemented**
- 6.3 Ranking contract: deterministic versioned engine, ≥70 % coverage gate, local cost AND rent
  evidence, owner-occupier renormalisation, hard constraints, sponsored separation, explanations,
  snapshots (`packages/domain/src/ranking`). **implemented** — the seed holds no rank-eligible
  evidence, so every market honestly shows "more local data needed" and financial ranking stays
  gated until locally reviewed evidence is published.
- 6.4 Calculators: development cost, area conversion rejecting "plot", long-let economics with the
  brief's worked example (6m / 5.4m / 4.2m / 6 % / 4.2 %), short stays with explicit nights,
  phasing, NPV/IRR with non-unique IRR labelling, sensitivity grids; the chart library loads only
  when a grid is shown. **implemented**
- 6.5 Three timelines: construction critical path with cycle rejection, bidding deadlines on
  server time, approvals with explicit day basis. **implemented** — timeline templates come from
  the seed only; observed approval durations are not yet collected (partial).

### §7 Seed data and market-data administration

- Validated idempotent import of the 50-market seed with provenance, immutable observations,
  versioned interpretations, editorial supplier leads, research tasks, conflict reporting and
  dry-run (`packages/db/src/seed`, `seed.test.ts`). **implemented**
- Admin workflows: create/edit/archive/restore, move point, merge, CSV/JSON import preview,
  sources, submit/approve/reject with separation of duties, revision comparison, publish/unpublish,
  rollback (audited), coverage editor, ranking/freshness/data policies; stale-evidence sweep opens
  deduplicated refresh tasks; cache invalidation job (`server/admin/market-data`,
  `apps/worker/src/market-data`). **implemented** — neighbourhood boundary editing, exports and
  research-task screens are covered by fewer tests than the core flows (partial test coverage).

### §8 Eight core service modules

Shared engagement state machine (inquiry → triage → quote → acceptance → invoice/payment → work →
evidence/review → delivery → completion) with permissions, reasons and billing consequences
(`packages/domain/src/workflow`, `packages/finance/src/engagements`). **implemented**

| Module                  | Status      | Evidence                                                                                                                                                                                                                                     |
| ----------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Construction monitoring | implemented | baseline, BOQ, budget commitments/actuals, milestones, site visits, media with capture metadata, progress reports, defects, change orders, owner approvals (`projects/flow.int.test.ts`, `change-orders.int.test.ts`, `reports.int.test.ts`) |
| Due diligence           | implemented | document checklist, survey references, legal/surveyor assignments, findings, queries, red flags, decision memorandum from template with named reviewer and limitations (`engagements/diligence.int.test.ts`)                                 |
| Architecture            | implemented | brief, site information, design options, drawings, revisions, comments, approvals tracker, BOQ, handoffs (`projects/isolation.int.test.ts` design case) — fewer dedicated tests than other modules                                           |
| Property management     | implemented | properties/units, leases, rent schedules, collections, arrears, maintenance, recurring inspections, owner statements, tenant tickets (`rentals.int.test.ts`, `tenant.int.test.ts`, `maintenance.int.test.ts`)                                |
| Virtual inspections     | implemented | appointment, checklist, findings with severity, live meeting link, reviewed report, print-ready export (`engagements/virtual-inspection.int.test.ts`)                                                                                        |
| Purchase representation | implemented | search criteria, shortlist, offers with negotiation log, conditions, diligence dependency, closing checklist, document handover, closing pack, agreed fee basis (`purchase/purchase.int.test.ts`)                                            |
| Property search         | implemented | requirements, saved searches with alerts, shortlist comparison with source labels, viewing bookings, feedback, accepted shortlist or documented outcome (`search/search.int.test.ts`)                                                        |
| Land sales/leasing      | implemented | owner authority, parcel/area, title disclosures, media, listing moderation, inquiry qualification, offers, lease milestones and documented outcome (`listings/listings.int.test.ts`, `inquiries.int.test.ts`)                                |

Evidence uploads store capture time, uploader, checksum and optional GPS separately from server
receipt time; restricted originals are retained, derivatives generated and only approved
versions published; large uploads are resumable and processed asynchronously. **implemented**

### §9 Service expansions

- Twenty-three expansion services seeded as feature-flagged workflow templates on the shared
  engine; regulated features (pooled investment, fractional ownership, wallets, escrow, lending,
  automated legal certification) require a reason and typed confirmation to enable and have no
  code behind them by design. **implemented (registry, flags, intake)**
- Dedicated workflow code exists for contractor tendering, materials procurement, preventive
  maintenance, estate management, short stays and student-housing leases; the other expansions run
  on the shared engagement/project engine only (documented per template in
  `docs/workflows/`). **partial by design**

### §10 Customer, tenant and partner experiences

- Onboarding (verified email, optional phone with SMS-code verification, time zone, goals,
  ownership type), household members with view/comment/approve rights, multiple organisations with
  cache reset on switch, home dashboard from real records, requests, quotes, invoices, change
  orders, plan annotations, uploads, bookings, messages, report export, notification
  preferences, saved scenarios into requests. **implemented**
- Property and project detail pages with the specified tabs; notes carry explicit visibility.
  **implemented**
- Tenants limited to their own lease data; invitations expire and can be revoked; public forms
  have abuse controls. **implemented**
- Contractors, inspectors (offline capture with unsynced state and per-user sealed drafts),
  vendors (RFQs, orders, discrepancy replies), legal/survey partners (assigned items and evidence
  only); staff approve customer-facing reports before release. **implemented**

### §11 Admin console and permission model

- Granular permissions with resource relationships, default deny on every mutation, query,
  export, download, job and subscription; MFA required for finance, access, data-publication and
  integration permissions; role matrix with the brief's exclusions
  (`packages/domain/src/authz`, `docs/guides/permission-matrix.md`). **implemented**
- Row-level security on 157 tables for the runtime role; production refuses to start if the role
  could bypass it. **implemented**
- Lead assignment, service availability by location, SLA queues and policies, workload/calendar,
  quotation templates, pricing, report templates, document requirements, notification templates,
  content publication, portfolio analytics, refunds, reconciliation, integration health, saved
  views, bulk actions with preview, global search, reconciling exports. **implemented**
- Support escalation: support tickets exist as conversations; there is no priority/escalation
  model (**partial**). Support impersonation: **not offered** (would require reason, expiry, banner,
  audit and financial/secret blocking; the auth library's own admin endpoints are refused).

### §12 Payment gateway and accounting

- Paystack adapter with initialisation, verification, HMAC-SHA512 webhooks, dedupe, reconciliation,
  refunds, chargebacks; balanced double-entry ledger with deferred constraint enforcement,
  receivables, revenue, gateway clearing, fees, refunds, rent liabilities, owner distributions and
  partner payables; bank-transfer receipts; installment plans; exports that reconcile.
  **implemented (development adapter)** — every payment test uses the labelled dev adapter or
  official webhook fixtures; no Paystack sandbox call has been made.

### §13 SMS provider configuration

- Termii adapter, sender ID and balance checks, delivery reports, STOP suppression, segment/cost
  estimates, test sends, phone verification codes; SMS only to verified numbers.
  **implemented (development adapter)** — Termii's documentation was unreachable from the build
  environment; the contract follows official snippets and must be verified against the sandbox.

### §14 SMTP configuration and notifications

- SMTP adapter with TLS/AUTH handshake and SPF/DKIM/DMARC checks, SSRF allow-list, templates with
  versions and rollback, transactional outbox, retry/backoff, dead letter with admin retry,
  delivery log, digests, quiet hours, bounce recording. **implemented (development adapter)** —
  no live mail account; bounces are recorded manually.

### §15 Google Calendar and Meet

- OAuth, free/busy, event and Meet creation, push channels, sync with etag recovery, DST-safe slot
  labelling, exclusion constraint so one slot has one winner, visible/retryable failures.
  **implemented (development adapter)** — Google itself has not been called.

### §16 Integration administration and secrets

- Save/test/activate/disable/rotate per provider and environment, envelope encryption with master
  key rotation and re-wrap job, fingerprints, sanitised logs and payloads, degraded/expired states
  from hourly checks. **implemented** — the master key lives in an environment variable; no
  external key vault.

### §17 Technical architecture

- Next.js 16 App Router, separate worker, PostgreSQL/PostGIS, Redis, durable queue with outbox in
  the business transaction, S3-compatible storage adapter, better-auth with organisations and MFA,
  pinned versions and lockfile, server-authoritative rules, idempotent financial and scheduling
  actions, dead-letter retry tools, structured sanitised logging with correlation ids, error
  tracking through Sentry's envelope endpoint when a DSN is configured. **implemented**

### §18 Data model and APIs

- 166 tables across identity, geography, intelligence, CRM/services, property, project,
  commercial, rental, finance, communications and platform; 485 documented API paths with the
  error envelope, pagination and idempotency contracts; migrations tested on a clean database and
  the previous snapshot. **implemented**

### §19 Security, privacy and reliability

- CSP with per-request nonces, security headers, HttpOnly/SameSite cookies, CSRF guard, rate
  limits, MFA, dependency audit and secret scanning in CI, the auth library's admin endpoints
  refused, uploads scanned and quarantined with signed expiring URLs, SVG/HTML never executed in
  the app origin, precise coordinates redacted from public listings unless approved, logs without
  tokens or private content. **implemented**
- Consent records, lawful-purpose notes, deletion requests with restricted retention, audit.
  **implemented** — a self-service personal-data export is not built (partial); professional
  review of launch policies remains an external task.
- Backups with encryption and verification, restore drill logged, monitoring of queue lag,
  webhook failures, sync failures, storage errors, provider balance and overdue reviews with
  staff alerts. **implemented** — the restore drill ran on seed data; repeat it on production
  data after launch.

### §20 CMS, search, migration and SEO

- CMS with draft/review/publish, scheduling, preview links, revisions, rollback, script
  sanitising, media picker limited to approved public media, banners, navigation, goal paths,
  location intros, policies, contact details. **implemented**
- Public listings with type, price, area, location, tenure/title-disclosure, availability and
  verification-scope filters; badge detail shows what was checked, by whom, when and until; owner
  authority and content moderated before publication; duplicates and expired availability
  distinguished; server-rendered detail pages with canonical URLs, sitemap, robots and accurate
  structured data without fabricated reviews. **implemented**
- Migration: inventory template, reconciliation script, redirects served with their configured
  status (301/302/308) from the proxy, CSV import, noindex on private and incomplete pages.
  **implemented** — the crawl of the current site and its content decisions are an owner task.

### §21 Acceptance scenarios

| #   | Scenario                                                                                             | Status      | Evidence                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Filter 50 locations, switch map/list, compare four, save, reload preserves; no invented prices       | implemented | `tests/e2e/specs/scenario-1.spec.ts`; `rank.test.ts` "never turns a missing value into a zero price"; `seed.test.ts` "imports 50 markets"                                                                              |
| 2   | Editor adds 51st market, imports, approver publishes; snapshots preserved; rollback audited          | implemented | `admin/market-data/markets.int.test.ts` (51st draft, approver publishes, rollback audited); `imports-policies.int.test.ts`; `scenarios.int.test.ts` snapshot case                                                      |
| 3   | Diligence request → versioned quote → sandbox payment → reviewed report; other customer denied       | implemented | `tests/e2e/specs/engagement-journey.spec.ts` (HTTP journey with the development adapter); `engagements/diligence.int.test.ts`; `finance/engagement-to-payment.test.ts`                                                 |
| 4   | Bid before closing only; no revisions after; no competitor visibility; award only when published     | implemented | `tenders/tenders.int.test.ts` "runs end to end with competitor isolation, sealing and award visibility"                                                                                                                |
| 5   | Change order cannot alter the approved budget without required approvals; variance and forecast      | implemented | `projects/change-orders.int.test.ts`                                                                                                                                                                                   |
| 6   | Duplicate/delayed/reordered payment events never double-allocate; bad signatures never settle        | implemented | `finance/webhook-idempotency.test.ts` (7 cases), `payments/paystack.test.ts`, `matching.test.ts` — fixtures and the development adapter, not a live gateway                                                            |
| 7   | Two users, one slot; Google failure visible and retryable; reschedule/cancel sync across DST         | implemented | `appointments/booking.int.test.ts` (concurrent hold, DST labelling), `calendar/sync.int.test.ts` (retry, expiry, etag, cancellation) — development calendar                                                            |
| 8   | Admin configures SMTP/SMS, explicit test sends, delivery distinctions, rotates a secret never leaked | implemented | `integrations/service.int.test.ts` (rotation, payloads and logs free of secrets), `admin/communications/communications.int.test.ts` (test sends, delivery log)                                                         |
| 9   | Owner statement accurate; tenant sees only own obligations; maintenance flow                         | implemented | `rentals.int.test.ts` (reconciled statement, two-approver payout), `tenant.int.test.ts`, `maintenance.int.test.ts`                                                                                                     |
| 10  | Inspector offline resume without duplication or leaks                                                | implemented | `lib/partner/offline/store.unit.test.ts` (per-user sealing, replay without duplicates), `projects/flow.int.test.ts` offline-safe submission                                                                            |
| 11  | Light/dark/system, reduced motion, keyboard, map fallback at 360 px and desktop                      | implemented | `journeys.spec.ts` (axe on every surface, both widths, dark theme + reduced motion), `scenario-1.spec.ts` (map fallback, keyboard-only journey with visible focus)                                                     |
| 12  | Unsupported/infected files unavailable; signed download expires; revoked membership blocks           | implemented | `files/files.int.test.ts` (blocked types, EICAR quarantine, scanner failure, expiry, revocation)                                                                                                                       |
| 13  | Backup restore reproduces balances, users, projects and object references                            | partial     | `ops/backup/restore.sh` verifies counts and ledger balance; drill logged in `docs/operations/backup-restore.md` on seed data; storage reconciliation CLI; no automated restore test                                    |
| 14  | No dead controls or fake dashboards                                                                  | implemented | dashboard counts derive from records (`server/admin/overview.ts`, analytics tests); controls hidden or explained by permission/flag (`admin.unit`, `portal.unit`, `partner.unit`); no remaining "arrives in wave" text |

## Test results (release candidate)

| Suite                                                                      | Result                                                              |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Typecheck (all packages and apps)                                          | clean                                                               |
| Lint (all packages and apps)                                               | 0 errors, 6 warnings                                                |
| Format check                                                               | clean                                                               |
| Unit projects (domain, contracts, integrations, ui, web-unit)              | 105 files, 907 tests passed                                         |
| Integration projects (db, finance, notifications, web-integration, worker) | {{INTEGRATION}}                                                     |
| Playwright (desktop + mobile-360): smoke, journeys, scenario 1, engagement | 53 passed, 1 skipped (mobile-only keyboard journey), 0 failed       |
| Production build (`next build`, standalone)                                | compiled successfully; 150 MB standalone output; no warnings        |
| Worker bundle                                                              | builds; starts and reports healthy                                  |
| Load check (100 concurrent browsing users, 60 s, local container)          | 3,431 requests, 56 req/s, 0 errors; p50 1.5 s, p95 3.2 s, p99 6.0 s |
| Dependency audit (`pnpm audit --prod --audit-level high`)                  | no known vulnerabilities                                            |
| Secret scan (tracked files)                                                | clean                                                               |
| Restore drill                                                              | verified on the development database                                |

Lab conditions: 4 vCPU, 15 GB RAM shared with the database, Redis and the test runner; no CDN,
no TLS termination. Field performance must be measured after launch.

Single-user lab timings on the same container (median of three cold loads, desktop Chromium):
home TTFB 43 ms / load 258 ms with 549 KB compressed JavaScript (the map bundle and chart library
load only when shown); explorer 24 ms / 203 ms; services, pricing and locations pages 23–49 ms
TTFB and under 200 ms load with about 217 KB of JavaScript. The brief's field targets (p75 LCP
≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1) can only be confirmed with real users on the production host.

## Integrations exercised against a real sandbox

None. Paystack, Termii, SMTP, Google Calendar/Meet, S3 storage, ClamAV and map tiles were
exercised only through labelled development adapters, contract fixtures (official Paystack
webhook fixtures, Google discovery document, Termii snippets) and an in-process fake ClamAV.
Production refuses development adapters. Live verification is the first task once credentials
exist (`docs/providers/README.md`).

## External inputs still required

- Paystack merchant approval, test and live key pairs, webhook URL registration.
- Termii account, approved sender ID, API key, delivery-report URL.
- SMTP account and SPF/DKIM/DMARC records for the sending domain.
- Google Cloud OAuth client, organiser consent, verified domain for push notifications.
- Licensed map tile account (style URLs) and optional geocoding.
- Hosting, domain and DNS control, database, object storage and backup destination.
- Approved brand assets and copy; the current site's content inventory and image rights.
- Locally reviewed prices for the eight services (seeded anchors are in review).
- Market evidence: the seed is geographically complete but financially incomplete by design;
  financial ranking stays gated until validated local cost and rental evidence is published.
- Appointed operational staff and partners; professional review of launch policies (data
  protection, terms, consent wording).

## Known limitations

- No PDF library: report export is print-optimised HTML (A4 stylesheet, "save as PDF").
- Support tickets have no priority/escalation model; support impersonation is not offered.
- Timeline templates come from the seed; observed approval durations are not collected.
- Dedicated workflows exist for six expansions; the rest use the shared engine only.
- Portal "documents we need" cannot tick off uploads (no file↔requirement link).
- Viewings of external shortlist entries link through the booked appointment only.
- Staff delivery/completion transitions do not yet require a released closing pack.
- Public media revocation is immediate server-side; browsers/CDNs may cache up to 24 h.
- When the proxy's redirect snapshot is unavailable the not-found fallback answers 307/308.
- SMTP bounces are recorded manually; no provider feedback loop.
- Guest numbers typed on public forms never receive SMS (only verified profile numbers).
- Unscheduled visits are project-scoped; partner invoices require a completed assignment.
- No self-service personal-data export; no automated restore test; restore drill on seed data.
- Explorer map, real-time Meet links and SMS delivery are unverified without provider accounts.

## Decisions to confirm with the owner

- Admin navigation adds five sections beyond the brief's list (Listings, Communications, Service
  Setup, Portfolio Analytics, Jobs & Outbox); they can be nested under existing sections instead.
- `core.anonymous_scenarios` now defaults off per §5; existing databases keep their stored value
  and must be switched by hand (`feature_flags`).
- Listing availability window is 90 days before re-confirmation is required.
- Partner payables post to accounts 5200 (materials) / 5300 (services) pending accountant review;
  the seeded tax treatment is a placeholder.
