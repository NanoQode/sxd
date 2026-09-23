# Admin configuration and portfolio analytics

Server workflows behind `/api/v1/admin/price-anchors/**`, `/quote-templates/**`,
`/report-templates/**`, `/document-requirements/**`, `/sla-policies/**` and
`/analytics/portfolio/**`, with their console pages under `/admin/services` and
`/admin/analytics`. Every mutation runs in one transaction under the caller's row-level-security
context, checks an explicit staff permission, records an audit event with the reason given, and
applies optimistic concurrency (`expectedVersion`, `expectedRevision` or `expectedUpdatedAt` for
rows without a version counter).

## Price anchors (`service_packages` + `service_package_revisions`)

Brief §2: editable starting prices with basis, minimum scope, exclusions, effective date and a
publication status that needs business review before publication.

- **The row is the live anchor.** `service_packages` holds what the public site shows. It changes
  only when a reviewer publishes; nothing else writes its values.
- **Every change is a revision.** `service_package_revisions` is append-only (database trigger).
  Each row records one event in `snapshot`: `draft_saved`, `submitted`, `published`, `rejected`,
  `withdrawn` or `retired`, with the full proposed values. Editing a draft appends another
  `draft_saved`; nothing is ever rewritten. `expectedRevision` is the highest revision the editor
  saw; the unique `(package_id, version)` index turns a race into `version_conflict`.
- **Proposal = the revisions since the last terminal event.** Its authors are everyone who saved
  or submitted in that chain. A seeded anchor (`in_review` row with no revisions) is an _implicit_
  proposal awaiting its first business review.
- **Separation of duties.** `publish` and `reject` are refused for anyone among the authors
  (`separation_of_duties`); an author withdraws instead. Publishing and retiring also need a
  verified authenticator (`mfa_required`, brief §11 data publication) and a reason.
- **Effective dates.** A published change with a future `effectiveFrom` keeps the previously
  published revision on the public site until that day (`effectiveAnchor` in
  `apps/web/src/lib/services/price-anchors.ts`). A first publication with a future date shows
  "Published price takes effect on …" and no figure.
- **Public contract.** `listServiceCatalog` exposes only published values in force today. An
  `in_review` package shows the review label and no amount, percentage, scope or exclusions; drafts
  and retired packages are not returned at all. Draft/in-review revisions are never read by the
  public path (`service_package_revisions` rows are filtered to `event = 'published'` in SQL).
- **Percentage bases** stay in basis points (`percentageBps`, 150 = 1.5%). A percentage anchor is
  a label only; the fee is invoiced solely from an agreed basis and signed scope (quote engine).
- Permission: `pricing.manage` (super admin, operations manager). Audit actions:
  `price_anchor.created|draft_saved|submitted|published|rejected|withdrawn|retired`.

## Quotation templates (`quote_templates`)

- Lines, scope and exclusions per service, or for every service (`serviceId = null`). Line
  amounts are recomputed with the quote engine's half-up rounding; negative units are refused.
- Read: `pricing.manage` or `quotes.issue`. Write: `pricing.manage`, reason recorded,
  `expectedUpdatedAt` token. Templates are deactivated, never deleted.
- **Prefill, not binding.** On a service request the quotes panel offers "Start from a quotation
  template": the lines, scope and exclusions are copied into the form and stay editable. The create
  call sends the edited `lines` plus `templateId` as provenance; the server uses the lines when
  present (the template only when no lines are sent) and refuses a template that is inactive or
  belongs to another service. The quote version stores its own copy, so later template edits never
  change a drafted or issued quote.

## Report templates (`report_templates`)

- One template per report kind is active. Creating or patching a template with `active: true`
  deactivates the kind's other active template inside the same transaction under an advisory lock
  (`report_templates:<kind>`), so two concurrent activations cannot leave two active rows.
- Sections are ordered `{ key, heading, guidance?, required }`; keys are unique snake_case. The
  limitations wording is required and is appended to every report of the kind. Guidance is for
  authors only.
- Read: `reports.draft`, `reports.review` or `reports.release`. Write: `reports.review`,
  `expectedVersion` and reason. Consumers call `activeReportTemplate(tx, kind)` from
  `apps/web/src/server/admin/configuration/report-templates.ts`; a report keeps its own copy of the
  sections it started from.
- Seed: `seedConfigurationDefaults` (run by `pnpm db:seed`) inserts one active template for
  `progress`, `inspection`, `virtual_inspection`, `diligence_memo`, `closing_pack` and
  `search_outcome` only when the kind has no template at all, so console edits are never
  overwritten. The wording states scope and limits and promises no legal, structural or title
  guarantee.

## Document requirements (`document_requirements`)

- Per service or for every service; `stage` is the engagement stage from which the document is
  needed (null = at intake); `required`, `sensitive`, `active`, `sortOrder`. Closed stages
  (`completed`, `rejected`, `cancelled`, `paused`) are refused.
- **Sensitive** marks identity papers, proof of funds and similar. They are collected only when the
  transaction requires them: never listed on public pages, shown to the customer inside their own
  request with that explanation, and opened only with `files.sensitive.read`.
- Customer view (`/portal/requests/{id}?tab=documents`): "Documents we need" splits the applicable
  requirements into those needed by the current stage and those needed later. A paused request uses
  the stage it was paused from; a closed request shows nothing. Uploads are not linked to
  requirements yet, so the list is guidance and the team confirms each document; nothing is ticked
  off automatically.
- Public view (`/services/{slug}`): "What you'll need" lists active, non-sensitive requirements
  (cached 60 s, cleared on every change).
- Read: `pricing.manage` or `service_requests.read_all`; write: `pricing.manage`.
- Seed: starter lists for the eight core services (only for a service that has no requirement
  yet). Global requirements are left for the business to add.

## SLA policies (`sla_policies`)

- Target hours per stage, per service or global, `businessHoursOnly`, `escalateToRole`, `active`.
  One active policy per service (or global) and stage, enforced under an advisory lock.
- Triage picks the most specific active `triage` policy (service before global; the earlier
  `DESC` ordering sorted the global NULL first and was corrected in
  `packages/finance/src/engagements/triage.ts`). Targets for other stages are stored and shown but
  not re-timed automatically: no escalation job exists yet, so `escalateToRole` is recorded only.
- Read: `sla.manage` or `service_requests.read_all`; write: `sla.manage`, reason,
  `expectedUpdatedAt`.

## Portfolio analytics (`/admin/analytics`)

Every figure is computed from records when the page loads; nothing is stored or hard-coded (brief
§19). Filters: date range (Africa/Lagos, default the last twelve months, at most five years) and
optionally one customer organisation.

| Section                | Source rows                                                                                                                                          | Time basis                    | Read permission                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------- |
| Properties & occupancy | properties not archived, their units, leases active on the date (not draft/pending, started, not ended or terminated)                                | as at range end (or today)    | `rentals.manage` or `projects.read_all` |
| Rent arrears           | rent and service-charge invoices with a lease, not draft/void, issued by the date; outstanding = total − allocations dated by then; aged by due date | as at range end               | `finance.read` or `rentals.manage`      |
| Active projects        | `status = active`; approved version total + contingency, commitments, actuals, pending/approved change orders → `computeBudgetVariance`              | current position              | `projects.read_all`                     |
| Open change orders     | draft, submitted, customer_review, staff_review on non-cancelled projects; exposure sums the three pending statuses                                  | current position              | `projects.read_all`                     |
| Service requests       | requests created in the range, by status and service; SLA state (`summarizeSla`) evaluated now                                                       | created in range              | `service_requests.read_all`             |
| Revenue by month       | journal lines on `ledger_accounts.type = 'revenue'` for journals posted in the range; net = credit − debit                                           | posted in range, Lagos months | `finance.read`                          |

- Sections the actor cannot read are `null`; project managers without a broader role see only the
  projects (`pmUserId`) and requests (`assignedPmUserId`) they manage (`scope: 'assigned'`).
- When no SLA policy is active the page says so instead of reporting breaches from thin air.
- Rent collected for owners is a liability, so it never appears as revenue.

### Reconciling analytics exports

`GET /api/v1/admin/analytics/portfolio/export?section=…` returns the rows each figure was summed
from, for the same filters. The summary and the CSV are produced from one loader per section, so:

- `properties`: `count(rows)` = Properties; `sum(units)` = Units; `sum(occupied_units)` = Occupied.
- `occupancy`: one row per unit; `sum(occupied_as_of)` = Occupied units.
- `arrears`: `sum(outstanding_kobo)` = Outstanding; the same sum where `bucket <> 'current'` =
  Overdue; per-bucket sums = the ageing table.
- `projects`: `sum(approved_total_kobo)` over `has_approved_budget = 1` = Approved budget;
  likewise `forecast_final_cost_kobo` and `variance_kobo`; `sum(committed_kobo)` /
  `sum(actual_kobo)` over all rows.
- `change_orders`: `sum(amount_delta_kobo)` where `pending_decision = 1` = Exposure;
  `count` per `status` = the status badges.
- `service_requests`: `count` per `status` / `service_name`; `sla_state_at_export = overdue` =
  Past SLA now, `due_soon` = Due within 8 hours.
- `revenue`: `sum(revenue_kobo)` = Revenue in range; grouped by `month_lagos` = the months table;
  by `account_code` = the accounts table. Each row names its `journal_id` and `business_event_ref`
  for tracing to the ledger.

Numbers in the CSV are plain integers (kobo), so spreadsheet sums are exact. Text cells that could
start a formula are prefixed with `'`. Arrears and revenue exports additionally require
`finance.export` (verified authenticator); every export writes an
`analytics.portfolio_exported` audit event with the section, filters and row count.

## Support escalation

Support tickets are conversations of kind `support_ticket` (opened from a customer page, handled
under Messages). There is no ticket model with priority, escalation level or assignee, and no
schema was added for it; escalation beyond the SLA `escalateToRole` field is therefore a documented
gap rather than a feature.
