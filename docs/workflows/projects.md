# Project delivery workflows

Server workflows behind `/api/v1/projects/**`, `/budgets`, `/milestones`, `/site-visits`,
`/reports`, `/defects`, `/change-orders`, `/approvals`, `/design-options` and `/permits`.
Every mutation runs in one transaction under the caller's row-level-security context, records
an audit event, applies optimistic concurrency where the row has a `version`, and appends an
outbox event for notifications (ids and recipient hints only). Authorisation is default deny:
the permission catalogue in `packages/domain/src/authz` plus the resource relationship.

## Who may do what

| Actor                                        | Reach                                                                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| super_admin, operations_manager, finance     | every project                                                                                                                 |
| project_manager                              | projects where they are `pmUserId` or have an assignment (proposed/accepted/active)                                           |
| inspector                                    | assigned projects; only visits that name them as inspector                                                                    |
| customer owner / approver / member / adviser | own organisation; approver-only actions need `org.change_orders.approve` / `org.milestones.accept` (owner and approver roles) |
| partner                                      | projects with an accepted/active assignment; `partner.reports.draft`, `partner.evidence.upload`, `partner.assignments.view`   |

Customers never see internal notes, storage keys, draft reports or restricted evidence
(only `approved`/`redacted_public` items and their own uploads). Reads are filtered in SQL and
again by the database policies.

## States and decisions

- **Project**: `planning → active → on_hold → active`, `active → completed`, `planning/active/on_hold → cancelled` (reason required for on_hold and cancelled), `completed/cancelled → archived`. Staff `projects.manage`.
- **Budget version**: `draft → approved → superseded`. Totals are always recomputed on the server (`area_rate` = area × rate, `boq` = Σ quantity × rate rounded per line, `quote` = the quote version's stored total, `manual`). A draft is approved only when its policy is satisfied: the baseline needs a customer approval (`org.change_orders.approve`) **and** a staff approval (`projects.manage`), recorded as `approvals` rows. Approval supersedes the previous approved version and sets `projects.approvedBudgetVersionId`. BOQ items cannot change once any decision exists.
- **Commitments/actuals**: append-only rows; corrections are new rows. Variance = commitment-based forecast from `packages/domain/src/projects/budget.ts` (pending change orders are exposure, never forecast).
- **Schedule**: replacing tasks creates a new `scheduleVersion`, runs the construction engine (cycles, duplicates and unknown keys are rejected with `validation_failed`), stores an append-only `schedule_baselines` snapshot with the critical path, and sets `forecastCompletionDate` only when every duration is known; otherwise it stays unknown (`null`).
- **Milestone**: `pending → in_progress → submitted → accepted | rejected → in_progress`. Three distinct actions: inspector progress (`milestones.record_progress`), customer acceptance/rejection with reason (`org.milestones.accept`), finance authorisation (`milestones.finance_authorize`, MFA, only after acceptance, once). None implies another.
- **Site visit**: `scheduled → in_progress → submitted → reviewed`, or `cancelled` with reason. Only the inspector named on the visit can start/submit; review needs `reports.review` and never the inspector. `offlineClientId` makes start/submit/sync idempotent: a repeat returns the stored row with `idempotentReplay: true`; another user's id is a `conflict`. `POST /site-visits/sync` reports `created | replayed | rejected` per item and per evidence file.
- **Report**: `draft/changes_requested → in_review → approved → released` via the shared `reportMachine`. Submission names a professional reviewer who is not the author and holds `reports.review`; review and release are refused for the author regardless of role. Release freezes the revision (`releasedVersion`, `customerVisible`). A later revision starts a new draft version; the released revision stays visible to the customer until a newer version is released, after which it is `superseded`.
- **Evidence**: links an uploaded file that is `clean`, belongs to the organisation (or is the uploader's own unattached file) and has a checksum; scanning/pending files return `file_quarantined`, infected/rejected/deleted files `file_rejected`. `capturedAt`/GPS are user-provided; `receivedAt` is server time. `evidence.approve` (not on one's own upload) sets `approved` or `redacted_public` with a redacted file.
- **Defect**: numbered per project; `open → acknowledged → in_progress → resolved → verified → closed`, `disputed` from acknowledged/in_progress/resolved/verified with reason. Verification needs `reports.review` or `projects.manage` and must not be the resolver (taken from the audit trail).
- **Change order**: `draft → submitted → staff_review/customer_review → approved | rejected | withdrawn`. Submission creates pending approvals for the roles the policy requires (at least one). Both may decide in any order; the status names the outstanding approval. Only when every required approval is `approved` does a new approved budget version (current approved total + delta) become the project budget, `appliedBudgetVersionId` is set and the forecast completion date shifts by `scheduleDeltaDays`. Any rejection rejects the order and leaves the budget untouched. The creator cannot give the staff approval and may withdraw while no decision exists. Policy extension over `changeOrderMachine`: `submitted → customer_review` when no staff approval is required, and `staff_review → approved` when the staff approval completes the policy.
- **Design option**: versions share a title; customer sign-off (`org.change_orders.approve`) is immutable — updates or a second sign-off return `conflict`; a new version supersedes the current one while a signed-off version keeps its record.
- **Permit application**: events are append-only; `submitted`, `query_raised`, `resubmitted`, `approved`, `rejected`, `withdrawn` move the status, `fee_paid`, `completeness_confirmed`, `note` do not. Statutory targets exist only with an explicit day basis and a source note; otherwise `statutoryTargetStatus` is `unknown`. Elapsed time is split between the applicant's and the authority's court.

## Approvals

`GET /api/v1/approvals?entityType=&entityId=` lists records for change orders, budget versions
and milestones the caller can read. `GET /api/v1/approvals/pending` shows the customer approvals
of the caller's organisation (approver roles) or the staff approvals the caller may decide.
Decisions are recorded only through the entity endpoints (`/budgets/{id}/decisions`,
`/change-orders/{id}/approve`, `/milestones/{id}/acceptance`).
