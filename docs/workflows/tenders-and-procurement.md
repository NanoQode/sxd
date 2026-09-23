# Contractor tendering and materials procurement

Wave 4 expansion modules. Both are feature-flagged (`expansion.contractor_tendering`,
`expansion.materials_procurement`); a disabled module answers `404 feature_disabled` on every
endpoint and keeps its records. Services live in `apps/web/src/server/tenders` and
`apps/web/src/server/procurement`; contracts in `packages/contracts/src/commercial.ts`; pure
calculations in `packages/domain/src/tenders` and `packages/domain/src/procurement`; routes are
registered for OpenAPI in `apps/web/src/lib/api/registry/commercial.ts`.

## Tendering (sealed bids)

### Who sees what

| Actor                          | Tender                                    | Bids                                                                                                     | Award                                                        |
| ------------------------------ | ----------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Staff `tenders.manage`         | all                                       | existence, partner and submission time until the bids are opened; content afterwards (every read logged) | any time                                                     |
| Staff `bids.evaluate`          | all                                       | as above; scores and comparison once opened                                                              | any time                                                     |
| Staff `bids.open_sealed` (MFA) | all                                       | opens the sealed bids with a reason after the tender closes (`bid_access_log` action `open`)             | any time                                                     |
| Customer (`org.read`, own org) | own organisation's tenders                | nothing until closed; existence after close; content once opened (logged)                                | once published                                               |
| Invited partner                | tenders they were invited to (not drafts) | only their own bid, at every stage                                                                       | once published: winner sees the award, others "unsuccessful" |
| Anyone else                    | `not_found`                               | `not_found`                                                                                              | `not_found`                                                  |

Row-level security is the second net: `tenders` are readable by the organisation and by invitees
of non-draft tenders, `bids` by the bidder, staff after the deadline/opening and system jobs. The
`bids` read policy has no organisation clause, so the customer read after opening runs elevated
inside the service once the explicit checks passed; `bid_access_log` is privileged-only and append-only.

### Lifecycle

`draft → published → (clarifications) → closed → evaluating → awarded`, with `cancelled` from any
non-terminal state (reason required). Transitions come from `tenderMachine` in
`packages/domain/src/workflow`.

1. **Create** (`POST /api/v1/tenders`, `tenders.manage`): organisation, optional project/service
   request, scope files (must belong to the organisation), optional BOQ budget version, the
   timeline (validated by the bidding timeline engine: release → site visit → question cutoff →
   answers → submission deadline → evaluation → award, each present stage after the previous),
   display time zone, named evaluation weights summing to 100 or 1.0, partner disclosure text.
   Reference `TND-YYYY-NNNN`.
2. **Publish** (`POST /tenders/{id}/publish`): deadline must still be in the future on the database
   clock; outbox `tender.published` with the invited partner ids.
3. **Revise** (`POST /tenders/{id}/revisions`): every change after publication is an append-only
   `tender_revisions` row holding the diff, an optional addendum and an optional deadline extension.
   A deadline only ever moves later (`extension_not_later` otherwise); `currentRevision` increments.
   Invitees are notified (`tender.revised`).
4. **Invite** (`POST /tenders/{id}/invitations`): partner users with a `partner_profiles` row.
   Statuses `invited → viewed` (first read by the partner) `→ declined | submitted`. The enum has no
   `accepted`; accepting records `respondedAt` and leaves the invitation open. The partner
   disclosure is shown to every invitee.
5. **Questions**: an invitee asks before the question cutoff (database clock); staff answer; a
   published answer is visible to every invitee anonymised (never who asked). Unpublished answers
   are visible to staff and the asker only. Publishing enqueues `tenders.publish_answers`.
6. **Bids**: an invitee creates a draft bid, adds revisions (amount in kobo, currency, line items,
   duration, qualifications, attachments they own), submits and may re-submit. Every submit,
   revision and withdrawal checks `now() < submission_deadline_at` inside the transaction, and the
   submit `UPDATE` repeats that check in SQL, so a stale browser can never slip past the deadline;
   afterwards the answer is `409 deadline_passed`. Bid revisions are append-only: submitting writes a
   new revision row stamped with the database time. `POST /bids/{id}/submit` is idempotent.
7. **Close**: the `tenders.close_due` job flips published/clarifications tenders at the deadline;
   staff may close manually only when the database clock has passed the effective deadline.
8. **Open sealed bids** (`POST /tenders/{id}/open-bids`, `bids.open_sealed`, MFA, reason): writes
   `openedAt/openedBy/openReason` and a `bid_access_log` row per bid. Starting evaluation opens
   unopened bids and therefore also requires `bids.open_sealed` on the actor.
9. **Evaluate**: each evaluator scores every named criterion 0–100; the weighted score is computed
   in `packages/domain/src/tenders` (`weightedScore`), stored as `numeric(8,4)`, one row per
   evaluator per bid. The comparison read model ranks by mean weighted score (ties: lower amount).
   Disqualification needs a reason (recorded in the audit event).
10. **Award**: `decideAward` creates the `awards` row (`decided`, contract value from the winning
    revision). `publishAward` sets `publishedAt`, moves the tender to `awarded`, the winning bid to
    `awarded` and the other evaluated bids to `unsuccessful`, appends `tender.award.published` and
    enqueues `tenders.notify_award`. Partners get `not_found` before publication. The winner
    accepts or declines. Post-award variations are `tender_revisions` rows with a reason.

Partner workspace: `GET /tenders/mine`, `GET /bids/mine`, `GET /tenders/mine/awards`, each filtered
to the caller in SQL.

## Materials procurement

1. **Supplier directory** (`GET /rfqs/supplier-directory`, `procurement.manage`): `supply_facilities`
   with `supplier_coverage` filtered by market/material/state, carrying the evidence labels the
   research seed imported (`published_facility_location`, `unverified_lead`, `verified_supplier`;
   coverage relation `editorial_lead`, `verified_delivery`, `dealer_appointed`). Prices appear only
   when a `supplier_quotes` row exists; `priceEvidence` says `no_quote_on_file` otherwise.
2. **RFQ**: staff create (`RFQ-YYYY-NNNN`) with items (material enum, specification, unit,
   quantity), issue with a deadline (`draft → sent`; the schema enum uses `sent` for "issued") and
   invite supplier users. An invitation is a draft `rfq_responses` row naming the supplier; that row
   is what row-level security uses to grant the supplier access. Staff can also record manual
   responses (`supplierName`, no account).
3. **Responses**: lines `{ itemId, unitPriceKobo, quantityUnit, declaredConversion?, leadTimeDays?,
note? }` plus response-level `deliveryKobo`, `leadTimeDays`, `validUntil`. Suppliers respond
   before the deadline (database clock). Stored in `rfq_responses.lines` as
   `{ version: 1, deliveryKobo, leadTimeDays, lines }`.
4. **Delivered-cost comparison** (`GET /rfqs/{id}/comparison`, domain `compareDeliveredCost`):
   quantities are normalised to the RFQ item's unit only through spelling aliases (m³ = m3) or a
   declared factor (`supplier_declared` or `staff_measured`, either direction). Without one the line
   is `comparable: false` with `unit_conversion_unknown`, the supplier's total stays `null` and the
   response is unranked; unstated delivery is `delivery_unknown`. Arithmetic is exact
   (scaled bigint) with a single rounding to kobo per figure; partial supplier units are flagged.
5. **Purchase orders**: created from a response with the lines copied and `totalKobo` (goods +
   delivery) computed server-side through the same comparison; unknown conversions must first be
   declared by staff (`lineConversions`, basis `staff_measured`). `POST /purchase-orders/{id}/issue`
   is idempotent, marks the response `selected` and the RFQ `awarded`, and appends
   `purchase_order.issued` for the supplier. Suppliers see and acknowledge orders only once issued;
   cancellation needs a reason. Number `PO-YYYY-NNNN`.
6. **Deliveries**: received quantity per order line, evidence files of the organisation,
   `deliveredAt`, receiver. `deliveryVariance` derives outstanding/excess per line and moves the
   order to `partially_delivered` or `delivered`. Delivery status `received → disputed → accepted`
   (`pending` is the enum's initial value, unused by the service).
7. **Discrepancies**: kind (`short_delivery`, `damaged`, `wrong_spec`, `other`), description,
   quantity, optional order line (kept in the delivery's line JSON as `discrepancyIds`). Flow
   `open → supplier_notified → resolved | credited | returned` with a resolution note; the
   supplier is told through `delivery.discrepancy.opened`. A delivery is accepted only when no
   discrepancy is open.

Vendors (`partner.deliveries.view`, `partner.rfqs.respond`) see exactly the RFQs, orders,
deliveries and discrepancies that name them.

## Outbox events and jobs

`tender.published`, `tender.revised`, `tender.invitation.sent`, `tender.question.asked`,
`tender.question.answered`, `tender.closed`, `tender.cancelled`, `tender.bids_opened`,
`bid.submitted`, `tender.award.published`, `tender.award.responded`, `rfq.issued`,
`rfq.response.submitted`, `purchase_order.issued`, `purchase_order.cancelled`,
`delivery.recorded`, `delivery.discrepancy.opened`, `delivery.discrepancy.supplier_notified`.
Payloads carry ids and recipient user ids only. Jobs `tenders.publish_answers` and
`tenders.notify_award` (worker `handlers/commercial.ts`) fan out `notification.requested` events
per recipient; `tenders.close_due` is scheduled in `handlers/maintenance.ts`.
