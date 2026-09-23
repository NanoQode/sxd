# Due diligence, virtual inspections and report export

How the platform records a due-diligence engagement (title and document
checklist, survey references, legal and surveyor assignments, site findings,
queries, red flags and the decision memorandum), how a virtual inspection is
captured and reported, and how a released report is exported. The same
engagement-item module carries the purchase-representation closing checklist
and the land-transaction milestones.

Brief references: §8 (Due diligence, Virtual inspections and the evidence
paragraph), §10 (export reports, partner access rules), §21 acceptance
scenario 3.

## Records: engagement items

Table `engagement_items` (migration 0007). One row per record on a service
request. `kind` decides the behaviour (`packages/domain/src/engagements/items.ts`,
`ENGAGEMENT_ITEM_KIND_RULES` — change a kind's rule there and every surface
follows):

| Kind | Used for | Rule highlights |
|---|---|---|
| `document_check` | Title and document checklist | Customers may upload against it; evidence required before `satisfied` |
| `survey_reference` | Survey plan / beacon references | `reference` required before `satisfied` |
| `site_finding` | Site or on-camera findings | Severity required; attached inspectors (`site_visits.perform`) may create |
| `query` | Question to the customer | Customers answer (response note) and may upload; customer notified on creation |
| `red_flag` | Issue affecting the decision | Severity required; customer notified when customer-visible |
| `condition`, `closing_task`, `handover_document`, `lease_milestone` | Purchase representation and land transactions | Handover documents need evidence before `satisfied`; closing tasks default to visibility `all` |

Statuses: `open → in_progress → satisfied | failed | waived | cancelled`.
Failed, waived, cancelled and every reopen need a reason (stored as the
resolution note and in the audit entry). Waiving and cancelling are staff
decisions; the assignee may start, satisfy or fail their item. Customers never
move a status: answering a query or uploading a requested document moves an
`open` item to `in_progress` so staff see it needs checking.

Visibility is explicit per item: `internal` (staff only), `customer`,
`partner` (assigned partners) or `all`. Row-level security (migration 0007)
lets staff read everything, customer organisation members read
customer/all items, assignees their own, and partners with an accepted/active
assignment on the request read partner/all items; the service applies the
finer rules on top (`apps/web/src/server/engagements/items.ts`,
`classifyItemViewer`).

Evidence: files are attached by id. Partners attach only files they uploaded
(purpose `evidence` on the service request); staff and customers may attach
files already on the request. Attaching records an `evidence` row (capture
time as supplied, uploader, checksum, server receipt time), shares the
uploader's file with the customer organisation when the item is customer
visible (partner evidence on internal or partner-only items is held back from
the organisation), and grants the item's assignee view access to evidence
they do not own. Each item lists only the files the caller may open under
the file policy. Identity documents are never attached to items.

Responses (customer answers, staff and assignee replies) are `notes` rows
with `entity_type = engagement_item` and the item's visibility at the time;
customers read customer/all responses, partners partner/all, staff and the
assignee everything.

Every mutation takes `expectedVersion`, writes an audit entry
(`engagement_item.created|updated|transitioned|evidence_attached|customer_responded|replied`)
and, where someone must act, an outbox event:

| Event | Recipients | Route |
|---|---|---|
| `engagement_item.assigned` | the assignee | partner: `/partner/items`; staff: the request page |
| `engagement_item.customer_action` | customer organisation members | `/portal/requests/{id}?tab=workspace` (new query, red flag, reply) |
| `engagement_item.responded`, `engagement_item.evidence_attached` | assignee, project manager, creator | request page |
| `engagement_item.transitioned` | none (event stream only) | — |

Resolvers live in `packages/notifications/src/registry.ts`; the worker maps
the events in `apps/worker/src/outbox.ts`.

## Assignments

Legal and surveyor partners are attached through the existing assignment
flow (`/api/v1/assignments`, propose → accept → activate). Only an accepted or
active assignment lets a partner reach the request; items may be assigned to
staff or to such partners (`assigneeUserId` is validated). Revoking the
assignment removes the partner's access to the request and its items at
once; their rows stay for the record.

## Decision memorandum and inspection report

Reports of kind `diligence_memo` and `virtual_inspection` are drafted
directly under a service request (`POST /api/v1/service-requests/{id}/reports`,
staff `reports.draft` attached to the request). The draft starts from the
active `report_templates` row of the kind (the one named, or the newest
active one; a built-in outline of headings is used when none exists and the
response says so): one `## Heading` per section, the template's standard
scope-and-limitations wording, and — when `referenceItems` is true — a
snapshot of the customer-visible items with their evidence names and
checksums in `report_revisions.findings.engagementItems`. Guidance is shown
to the author (admin report page, draft dialog) and never enters the body.
Every later revision carries the template forward and re-captures the
snapshot, so a released version is self-contained.

Lifecycle is the shared report lifecycle (`apps/web/src/server/projects/reports.ts`,
now scope-aware): revisions, submit for review naming a professional
reviewer who is not the author and holds `reports.review`, review by someone
other than the author, release by `reports.release` and again never the
author. Additional content rules for these kinds
(`packages/domain/src/engagements/reports.ts`, applied at submit and release):

- a scope and limitations statement is required;
- every required template section must have content;
- a decision memorandum is refused while it contains affirmative guarantee
  wording ("we guarantee…", "title is guaranteed…"): the memorandum records
  findings within its stated scope and is not a legal guarantee. Nothing the
  system generates (outline, limitations, export) contains guarantee wording.

Customers read the released revision only (`/portal/reports/{id}`, and the
request's workspace tab lists released reports). The existing
`project.report.released` notification covers request reports.

## Virtual inspections

A virtual inspection request uses: an appointment of kind
`virtual_inspection` linked to the request (the live meeting link is shown to
the customer and staff only while the conference is `ready` and the
appointment active); `site_finding` items as the checklist and annotated
findings (severity `info … critical`, location in `reference`, photos as
evidence with user-supplied capture time); and a `virtual_inspection` report
drafted under the request from its template, reviewed and released as above.
The workspace read model (`GET /api/v1/service-requests/{id}/workspace`)
returns items, summary, reports and appointments for the caller's view.

## Report export

`GET /api/v1/reports/{id}/export` renders the released version of any report
(project or request scope) as a print-ready HTML document: title, version,
release date, author, named reviewer and review date, released by, scope and
limitations, the body (sanitised markdown), the frozen engagement records
(red flags with severity, site findings, checklist status), evidence
references (file names and SHA-256 checksums for attachments, linked
evidence and item evidence — never signed URLs) and the footer
"Released report version N — generated <date>". Authorisation equals reading
the released report; each export writes a `report.exported` audit entry.
`?download=1` sends it as an attachment.

There is no PDF library in the stack, so the document is optimised for the
browser's print pipeline (A4 `@page`, print-safe colours, repeated table
headers) and tells the reader to use Print → Save as PDF. Export buttons sit
on the portal report page, the request workspace and the admin report page.

## Surfaces

- Customer portal: request → tab "Due diligence" / "Inspection" / "Closing"
  (label follows the workflow) with the waiting-on-you list (answer queries,
  upload requested documents), red flags with severity, checklist, survey
  references, findings, released reports with export, appointments with the
  live link. The overview's "Waiting on you" card counts open queries and
  document requests.
- Admin: service request → "Engagement records" (add, edit, assign,
  transition with reasons, attach evidence, reply; open/all filter) and
  "Reports" (draft from template with the outline and guidance shown, list,
  export). Report page: template section status, the revision's item
  snapshot, export of the released version, link back to the request.
- Partner workspace: "Assigned items" lists the partner's items across
  requests (filter by request from the assignment card), with record
  findings, upload evidence, start/satisfy/fail with reason and reply.

## Tests

- `packages/domain/src/engagements/engagements.test.ts` — per-kind rules,
  transitions, customer input, summaries, template sections, content checks.
- `apps/web/src/server/engagements/diligence.int.test.ts` — scenario 3
  journey with cross-organisation denial of every id (items, memo, export,
  files).
- `apps/web/src/server/engagements/virtual-inspection.int.test.ts` —
  findings with severity and evidence, meeting link exposure, reviewed
  inspection report and export.

Run: `npx vitest run --project domain packages/domain/src/engagements` and
`npx vitest run --project web-integration apps/web/src/server/engagements`.
