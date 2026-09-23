# Property management: leases, rent, tenants, maintenance, statements and payouts

Server workflows behind `/api/v1/leases/**`, `/rent/**`, `/tenant/**`, `/work-orders/**`,
`/assets/**`, `/owner-statements/**`, `/payouts/**` and `/estates/**` (code in
`apps/web/src/server/rentals` and `apps/web/src/server/maintenance`, pure maths in
`packages/domain/src/rentals`, contracts in `packages/contracts/src/rentals.ts`, OpenAPI in
`apps/web/src/lib/api/registry/rentals.ts`). Every mutation runs in one transaction under the
caller's row-level-security context, checks the permission catalogue plus the resource
relationship (default deny), records an audit event, uses optimistic concurrency where the row has
a `version`, and appends an outbox event (ids and recipient hints only). Money is integer kobo
(decimal strings in the API); dates without time are `YYYY-MM-DD`.

Rent collected on an owner's behalf is a liability to that owner (account 2100), never SimplexD
revenue; only the agreed management fee is revenue (4100). No rate is ever invented: schedules
scale the agreed rent by days, and statements use only the lease's own fee terms.

## Who may do what

| Actor                                                    | Reach                                                                                                                                                                                                                                                       |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| staff `rentals.manage` (operations)                      | leases, charges, statements, the rent job; proposes payouts                                                                                                                                                                                                 |
| staff `maintenance.manage`                               | raise, triage, dispatch, verify and close work orders; asset register                                                                                                                                                                                       |
| staff `estates.manage`                                   | estates, service-charge runs                                                                                                                                                                                                                                |
| staff `finance.payouts.first_approve` / `second_approve` | payout approvals (MFA-gated; the second approver must differ from the first, the proposer cannot approve first); `finance.reconcile` submits, settles or fails a transfer                                                                                   |
| read-only staff (`customers.read`, `finance.read`)       | read leases, balances, work orders and statements; never move work or post journals                                                                                                                                                                         |
| owner organisation                                       | `org.leases.manage` leases, parties, notices, stays; `org.maintenance.request` raise/cancel work; `org.change_orders.approve` approve/reject costs and verify work; `org.properties.manage` assets and estates; `org.read` read, statements once reconciled |
| tenant (active lease party)                              | `tenant.*`: own lease summary, balance, charges, receipts, tickets, appointments and notices; raise tickets and cancel tickets they reported                                                                                                                |
| contractor (partner or staff assignee)                   | work orders assigned to them: start, estimate, evidence, complete                                                                                                                                                                                           |

A tenant sees only leases where they are an **active** party (`lease_parties.access_status`,
enforced by the service and by `app.can_access_lease`); the tenant lease view drops management-fee
terms and other parties, and statements, payouts and journals are unreachable. Another
organisation's records answer `not_found`.

## Leases

- **States** (`leaseMachine`): `draft → pending_signature → active`, `draft → active`,
  `active → expiring → ended`, `active|expiring → terminated` (reason required). Owners and staff
  activate; only staff end a lease by hand; the rent job applies the system transitions
  (`leaseLifecycleTarget`): `expiring` from `noticePeriodDays` (default 30) before the end date,
  `ended` the day after it. Activation is refused while another active or expiring lease occupies
  the unit for overlapping dates; it marks the unit occupied and generates the schedule. Ending or
  terminating releases the unit unless another lease holds it.
- **Terms** beside the columns (a `notes` row `lease_terms`): service charge per period, due-date
  lead, proration flag, move-in inventory (rooms, items, condition, photos, tenant acknowledgement).
  Academic terms and a guarantor (stored as a `guarantor` party) are the student-housing variant
  behind `expansion.student_housing`. Dates, rent and period are frozen once active.
- **Parties and invitations**: `POST /leases/{id}/parties` stores a hashed single-use token with an
  expiry and emits `tenant.invited` (link `/tenant/invitations/accept?token=…`). The invitee accepts
  signed in with the invited e-mail (`POST /tenant/invitations/accept`); a lapsed token is marked
  `expired` (also by the rent job); revocation sets `revoked` and removes access at commit.
- **Renewal** creates the successor as a draft with the same parties (active tenants keep access).
  A fixed-term lease renews after its end date and runs to the end; an open-ended lease renews at
  the start of a period not invoiced yet (or after its last period): its end date becomes the day
  before and its later periods are waived. Emits `lease.renewed`.
- **Termination** on `terminatedOn` (within the term, default today): uninvoiced periods after it
  are waived, an uninvoiced period straddling it is cut at that day and its charges scaled by the
  days kept (`truncateCharge`). Issued invoices stay as they are; finance credits any unused part
  with a credit note. Waived charges no longer count in balances, arrears or statements.

## Rent schedules, invoices and arrears

- `generateRentSchedule`: periods start on the lease start date and repeat every 1/3/12 months
  (month-end clamped); academic leases take their terms verbatim. A last period cut by the end
  date is prorated as rent × days ÷ days of the full period it belongs to, half-up to the kobo
  (`prorateByDays`), unless the lease sets `prorate: false`. Due date = period start − lead days.
  Each period gets a `rent` charge (plus a `service_charge` charge when set); a deposit becomes one
  `deposit` charge. Owners and staff add ad-hoc `late_fee`, `utility`, `other` charges; they ride
  on the next rent invoice.
- The **rent job** (`runRentInvoicing`, worker `rent.generate_due_charges`) processes each lease in
  its own transaction under an advisory lock: deposit invoice once; one `rent` invoice per period
  due within 14 days, issued through `@simplexd/finance` with `isRentOnBehalfOfOwner = true`, the
  owner as the invoice organisation, the estate `estateSegment` when the property is in an estate,
  and the active tenant as customer (journal `invoice:<id>:issued`: Dr 1300 / Cr 2100). Zero-rent
  periods are closed as waived. Failures are listed per lease and retried next run.
- **Collections**: settled finance allocations on lease invoices (gateway, bank transfer, credit
  note) are mirrored into `rent_allocations`, apportioned oldest charge first
  (`apportionAllocation`); period status follows `scheduleStatusFor` (paid, partially paid,
  overdue). The first time a period turns overdue a `rent.overdue` late notice is emitted. Reads of
  a balance refresh the mirror first (elevated, after the caller was authorised).
- **Balance** (`GET /leases/{id}/balance`, tenant `…/balance`): charged, paid, outstanding (every
  unpaid charge raised, including periods not yet due), deposit held, next due, and arrears ageing
  by days past the due date (`current`, `1–30`, `31–60`, `61–90`, `>90`).

## Maintenance and assets

- **Work orders** (`workOrderMachine`) are raised by owners, tenants (on their own lease, scoped to
  its property/unit) or staff; the SLA deadline comes from the priority (urgent 4 h, high 24 h,
  normal 72 h, low 168 h) and `slaBreached` is computed on read. Staff triage and dispatch a
  contractor (staff member or registered partner), which creates an accepted `contractor`
  assignment. The assignee starts work, may request owner approval of an estimate, attaches evidence
  (clean files of the organisation or the uploader) and completes (evidence required). The owner
  approves or rejects the cost. Verification (staff, or the owner) posts the recoverable expense
  `work_order:<id>:expense` (Dr 5200 / Cr 2400) under the system context; staff close. Cancel needs
  a reason.
- **SLA job** (`work_orders.sla_check`, every 15 minutes): open work past its deadline is flagged
  once (audit `work_order.sla_breached` + outbox); `GET /work-orders?breachedOnly=true` lists them.
- **Assets** (`expansion.preventive_maintenance`): register per property (or estate) with warranty
  dates (`active`, `expiring` within 30 days, `expired`) and a service interval; the SLA job raises
  one recurring `preventive` work order per due asset and advances its next service date.

## Owner statements and payouts

- `POST /owner-statements` (staff) builds a draft for an organisation, optionally one property or
  estate, and a period: rent and service charges **collected** in the period (money allocations;
  credit notes are not collections), the management fee per lease (`percentage_of_collected` on
  rent via `bpsOf`, or `fixed_monthly` × months), verified maintenance not yet recovered, arrears
  and open obligations (arrears, open work). Net = collected − fees − recoveries; arrears are shown,
  never netted. Short-stay income and costs appear as information lines outside the totals.
- **Reconcile** posts the fee journals (`managementFeeFromCollectedRent`: Dr 2100 / Cr 4100) and
  recoveries (`maintenanceExpenseRecovered`: Dr 2100 / Cr 5200), recomputes collected, fees and
  recoveries from allocations and journal lines, and becomes `reconciled` (with a balanced
  `reconciliations` row) only when every figure matches; otherwise it stays a draft (`conflict`).
  **Issue** publishes it to the owner (`owner_statement.issued`). Owners never see drafts.
- **Payouts** (`payoutMachine`): proposed from a reconciled statement, never above its net payable
  (`owner_distribution`); first approval (not the proposer, reconciliation balanced); second
  approval by a different approver posts `payout:<id>:approved` (Dr 2100 / Cr 2400); finance marks
  it submitted, then settles against the bank reference (`payout:<id>:settled`: Dr 2400 / Cr 1000)
  or records a failure. Propose and settle honour `Idempotency-Key`.

## Estates and short stays

- **Estates** (`expansion.estate_management`): an estate groups one organisation's properties under
  its own `ledgerSegment`. A service-charge run (staff `estates.manage`, `Idempotency-Key`) raises
  the period's charge on every active lease in the estate and issues one `service_charge` invoice
  per lease on the segment (once per period and lease). Resident issues are work orders with
  `estateId` (`GET /estates/{id}/issues`); shared assets carry `estateId`; statements can be scoped
  to the estate.
- **Short stays** (`expansion.short_stay`): bookings per unit with an atomic no-overlap check under
  a per-property lock (same-day turnover allowed; a whole-property booking blocks every unit and the
  reverse), `requested → confirmed → checked_in → checked_out` or cancelled with a reason.
  Check-out raises a high-priority `turnover` work order. Income and platform/cleaning costs appear
  on the owner statement.

Expansion endpoints answer 404 `feature_disabled` while their flag is off (route and service
gates); records created while a flag was on are kept.

## Jobs and events

| Job (worker)                | Schedule   | Web equivalent                                                            |
| --------------------------- | ---------- | ------------------------------------------------------------------------- |
| `rent.generate_due_charges` | hourly     | `runRentInvoicing` / `POST /api/v1/rent/invoicing-runs` (staff)           |
| `work_orders.sla_check`     | 15 minutes | `checkSlaBreaches` + `generateRecurringWorkOrders` (`server/maintenance`) |

Outbox events, all routed to `notifications.dispatch` (`work_order.transitioned` keeps its
existing route): `tenant.invited`, `tenant.notice`, `lease.transitioned`, `lease.renewed`,
`rent.invoice_issued`, `rent.overdue`, `owner_statement.issued`, `payout.transitioned`,
`work_order.sla_breached`. Notice posts also write in-app `tenant_notice` notifications directly.

## Known gaps

- `invoices.owner_organization_id` is left null on rent and service-charge invoices: the owner is
  the invoice organisation. `invoiceIssued` (packages/domain/src/ledger/postings.ts) writes that
  text organisation id into `journal_lines.entity_id` (uuid), so setting it fails the issue journal
  (and a later void). Once the posting stops doing so, set it at invoice creation.
- The notification registry has no resolvers or templates yet for the events above; dispatch logs
  and skips them until they are added.
