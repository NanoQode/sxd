# Property search and purchase representation

How the platform runs the two buyer-side core services of build brief §8:
**Property search** (requirements, saved searches with alerts, shortlist
comparison, viewings with feedback; completion = accepted shortlist or a
documented search outcome) and **Purchase representation** (search criteria,
shortlist, offers with an append-only negotiation log, conditions, diligence
dependency, closing checklist, document handover; completion = approved
closing pack plus the agreed fee basis). Also the §2 fee rule: a
purchase-support invoice is never calculated without an agreed percentage
basis and a signed scope.

Brief references: §2 (purchase-support fee), §8 rows _Purchase
representation_ and _Property search_, §10 (customer decisions, note
visibility), §21 acceptance.

Code: `packages/domain/src/search`, `packages/domain/src/purchase`,
`packages/contracts/src/search-purchase.ts`,
`packages/finance/src/engagements/fee-basis.ts`,
`packages/notifications/src/search-purchase.ts`,
`apps/web/src/server/search/**`, `apps/web/src/server/purchase/**`,
`apps/worker/src/handlers/search.ts`. OpenAPI:
`apps/web/src/lib/api/registry/search-purchase.ts` (tag `search-purchase`).

## Access model

Every record hangs off a service request. The customer organisation reads
its own records (`org.read`); staff read them with `service_requests.read_all`
(a project manager only when attached to the request) and manage them with
`service_requests.triage` / `projects.manage`. Partners never see them. Row-level
security is the second net: `shortlists`, `shortlist_items`, `offers` and
`viewings` are organisation-scoped; `saved_searches` are owner-only; engagement
items follow migration 0007. Another organisation's id answers `not_found`; an
unattached project manager `forbidden`. Closed requests (completed, cancelled,
rejected) are read-only.

Customer authority by organisation role: rating, feedback and post-viewing
feedback need `org.comment`; requesting a viewing `org.appointments.manage`;
drafting an offer `org.requests.create`; committing the organisation (submit,
revise, accept a counter, withdraw an offer, accept the shortlist)
`org.quotes.accept` (owner or approver); acknowledging a handover document
`org.documents.view`.

## Property search

### Saved searches and alerts (`saved_searches`)

- Criteria (`searchCriteriaSchema`): listing kinds, property kinds, price and
  area range (integer kobo, m²), markets and states (a listing matches when
  its market **or** its state is chosen), tenure disclosed, title disclosure
  present, required verification checks (listing verification-scope items such
  as `title_document_sighted`, unexpired and not `issue_found`), keywords.
  Criteria that would match every listing are refused.
- Honesty: a listing that does not disclose its price or area never matches a
  price or area bound (`matchListing`, `packages/domain/src/search`).
- The search belongs to its owner in the organisation that was active when it
  was saved (switching organisation hides it). `expectedUpdatedAt` is the
  concurrency token.
- **Alerts.** Enabling alerts (or changing criteria with alerts on) sets the
  watermark `last_run_at = now`, so earlier listings are never announced
  retroactively. The worker job `search.saved_search_alerts` (every 15 min,
  body `runSavedSearchAlerts` in `@simplexd/notifications`, shared with the
  tests) examines listings published since the watermark minus a one-hour
  overlap, and for each new match enqueues one `notifications.dispatch` job
  keyed `saved-search-alert:<search>:<listing>`. That dedupe key is the ledger:
  a listing is announced **at most once per search**, however often the job
  runs or overlaps; the watermark then moves to the run time (or to the first
  listing left for the next run when a run caps at 25). The job leaves the
  owner's `updated_at` untouched. The resolver `saved_search.matched` sends
  in-app + email through the `activity_update` template, linking to the public
  listing.
- Preview: `GET /saved-searches/{id}/matches` lists today's matching listings
  (public-safe fields only).

### Shortlists (`shortlists`, `shortlist_items`)

Statuses `draft` (staff only) → `shared` → `accepted` | `outcome_recorded`
(both frozen). Staff add entries from **published listings** (facts are read
from the published revision at display time, never copied) or as **external
references** (source reference required, title, optional asking price as the
source stated it). Listing entries cannot carry a typed price; the customer's
own listing cannot be shortlisted for them; duplicates are refused.

The **comparison** (`buildComparisonRow`) shows price, price basis, area,
tenure, title disclosure, verification scope, location and location
precision, availability — each value labelled with its source (`listing` or
`shortlist_entry`) or `null` = "not disclosed". A listing that is no longer
publicly visible contributes nothing (stale facts are withheld). Nothing is
estimated.

Customers rate (1–5), comment and mark entries preferred / not for us. The
customer's preference is never overwritten by staff or viewing outcomes.

### Viewings (`viewings`)

Linked to the request either through the shortlisted listing (`listing_id` +
organisation) or through a `viewing` appointment booked on the request with
the existing booking flow (external properties: book the appointment, then
record it as a viewing). Lifecycle `requested → confirmed → completed |
no_show`, `cancelled` from any open state; staff confirm (a time is required),
reschedule or link the appointment; completing a viewing marks the
candidate entry `viewed`. The customer leaves feedback once the viewing took
place. Events: `viewing.requested` (assigned staff), `viewing.updated`
(requester).

### Completion

- **Accepted shortlist**: the customer (owner/approver) accepts a shared
  shortlist; the acceptance (who, when, note) is recorded as a customer-visible
  note on the shortlist and announced to the assigned staff.
- **Documented outcome**: staff record one of `property_selected`,
  `proceeding_to_purchase`, `no_suitable_property`, `customer_paused_search`,
  `purchased_elsewhere` with a summary. This drafts a `search_outcome` report
  under the request (shared report lifecycle: named reviewer who is not the
  author, review, release) with the shortlist tallies, entries, viewings and
  feedback in the body and structured `findings`, and freezes the shortlist.
  The customer sees the outcome summary once the report is released; until
  then only the status.

## Purchase representation

Search criteria and shortlist are the same records as above. The service's
workspace is `GET /service-requests/{id}/purchase`.

### Offers and the negotiation log (`offers`)

An offer belongs to the buyer's organisation (`counterparty_organization_id`
stays null: the seller's side is recorded by the representative). One live
offer per request. Subject: a shortlist entry (listing or external) or a
published listing; the subject is frozen in the first log entry.

State machine (`offerMachine`, `packages/domain/src/purchase`):

| From                    | Action   | To          | Who                                                                                  |
| ----------------------- | -------- | ----------- | ------------------------------------------------------------------------------------ |
| `draft`                 | submit   | `submitted` | customer with `org.quotes.accept`; staff with the customer's instruction in the note |
| `draft`                 | withdraw | `withdrawn` | customer or staff                                                                    |
| `submitted`             | counter  | `countered` | staff (seller's counter; amount required)                                            |
| `submitted`             | accept   | `accepted`  | staff (seller accepted)                                                              |
| `submitted`/`countered` | reject   | `rejected`  | staff, reason required                                                               |
| `submitted`/`countered` | withdraw | `withdrawn` | customer/staff, reason required                                                      |
| `countered`             | revise   | `submitted` | buyer's revised offer (amount required)                                              |
| `countered`             | accept   | `accepted`  | buyer accepts the counter                                                            |
| `submitted`/`countered` | expire   | `expired`   | staff or system                                                                      |

Invalid transitions, wrong actors and missing amounts/reasons are refused
(`invalid_transition`, `forbidden`, `validation_failed`). Every action appends
`{at, byUserId, action, amountKobo?, note, status, actor}` to
`negotiation_log`; `assertAppendOnly` verifies the stored prefix before every
write, `expectedEntries` (the log length) is the concurrency token, and the
update is conditional on the status the caller saw. Draft edits are logged as
`amended`. When an offer is accepted its terms become `condition` engagement
items linked to the offer (`subject_type = 'offer'`), in the same transaction.
Event `purchase_offer.updated` (customer organisation + assigned staff).

### Conditions, closing checklist and handover (engagement items)

Kinds `condition`, `closing_task`, `handover_document` are managed through the
generic engagement-items service (`apps/web/src/server/engagements/items.ts`:
create, update, transition with reasons, attach evidence) via the purchase
endpoints, with these rules on top:

- **Waive, fail and cancel need a reason** (recorded as the resolution note and
  shown to the customer).
- A **handover document** is satisfied only when the **customer acknowledges
  receipt** (`POST /purchase-items/{id}/acknowledge`): staff attach the files
  (the document moves to `in_progress` and the customer is told:
  `purchase_handover.ready`), the customer acknowledges (`satisfied`, resolved
  by a member of the organisation, note "Receipt acknowledged by the
  customer"; event `purchase_handover.acknowledged`). Staff cannot mark it
  satisfied.

### Diligence dependency

A `condition` item with `subject_type = 'diligence_request'` links the
customer's due-diligence request (same organisation, workflow
`due_diligence`). It is evaluated live, with elevated rights so internal red
flags count too: closing is blocked while the linked request has red flags
that are `open`, `in_progress` or `failed`, or no released `diligence_memo`
report, or was cancelled/rejected. Customers see the blockers but not internal
counts. Staff holding `service_requests.override` may waive the dependency
with a reason (shown to the customer); relinking restores the live check.

### Closing readiness and the closing pack

`closingReadiness` (`packages/domain/src/purchase`) blocks with codes
`no_accepted_offer`, `conditions_open`, `conditions_failed`,
`diligence_not_linked`, `diligence_red_flags_open`,
`diligence_memo_not_released`, `diligence_request_closed`,
`closing_tasks_open`, `handover_documents_missing_files`,
`handover_not_acknowledged`, `fee_basis_not_agreed`. The workspace shows them
to both sides.

`POST /service-requests/{id}/purchase/closing-pack` (staff, `expectedVersion`
= request version) is refused with `insufficient_evidence` while any blocker
remains; otherwise it drafts a **`closing_pack` report** under the request
(transaction and accepted offer, conditions and diligence, checklist,
documents handed over with their files, agreed fee basis; structured
`findings.closing`). The pack then follows the report lifecycle (named
reviewer ≠ author, review, release by someone other than the author). The
released pack is the approved closing pack — together with the agreed fee
basis, the completion evidence. Staff then move the engagement to delivered
through the existing transitions.

## Purchase-support fee rule (§2)

`packages/finance/src/engagements/fee-basis.ts`, enforced in `issueQuote` and
`acceptQuote`. A quote is percentage-based when its fee basis carries a
percentage **or** the requested service is priced on a percentage basis (its
package `price_basis = 'percentage'`, e.g. purchase support at 150 bps). Such a
quote is issued or accepted only when:

- `feeBasis.percentageBps` and `feeBasis.basisAmountKobo` (the agreed purchase
  price, or an explicit cap: `basisKind`) are recorded — the single quote line
  is derived from them (`bps × basis`); typed lines or templates are refused;
- `feeBasis.signedScopeFileId` references a **clean** file attached to this
  service request (the customer-signed scope) and the version states its
  scope;
- the stored lines still equal the derived fee.

Otherwise `insufficient_evidence` with the missing paths. On acceptance the
agreed basis (`percentageBps`, `basisAmountKobo`, `basisKind`,
`signedScopeFileId`, `agreedAt`) is written to `service_requests.fee_basis`,
and the invoice raised on acceptance is computed from that basis only
(`percentage-fee.test.ts`). Staff draft the quote from the purchase panel
(_Draft percentage-basis quote_) and issue it from the Quotations section.

## Notifications

Outbox events routed to `notifications.dispatch` and resolved in
`packages/notifications/src/search-purchase.ts` (all through the
`activity_update` template, in-app + email unless noted): `saved_search.matched`,
`shortlist.shared`, `shortlist.accepted`, `shortlist.outcome_recorded`,
`viewing.requested`, `viewing.updated`, `purchase_offer.updated`,
`purchase_item.created`, `purchase_handover.ready`,
`purchase_handover.acknowledged` (in-app), `purchase_closing.submitted`.

## Tests

- `apps/web/src/server/search/search.int.test.ts` — saved search RLS and
  service isolation; alerts only for new matching listings and never twice;
  shortlist visibility (customer org, assigned staff; other org and unattached
  PM denied); comparison never fabricates; feedback, viewings and feedback;
  acceptance freezes; documented outcome as a report.
- `apps/web/src/server/purchase/purchase.int.test.ts` — offer state machine
  and actors; append-only log and log-length concurrency; accepted terms become
  conditions; diligence dependency blocks and clears (resolve/waive red flags,
  released memo, override waiver); conditions/checklist/handover with customer
  acknowledgement; closing pack refused without the agreed fee basis, drafted
  as a report when ready; cross-organisation denial for every id.
- `packages/finance/src/engagements/percentage-fee.test.ts` — the §2 rule.

Run: `npx vitest run --project web-integration apps/web/src/server/search/search.int.test.ts apps/web/src/server/purchase/purchase.int.test.ts`
and `npx vitest run --project finance packages/finance/src/engagements/percentage-fee.test.ts`.

## Known gaps

- Offers of a represented buyer share the `offers` table with listing offers
  (buyer ↔ owner on the platform, `apps/web/src/server/listings/offers.ts`).
  Purchase-representation offers always carry `service_request_id` and no
  counterparty organisation; listing-offer views should exclude rows with a
  service request. The two negotiation-log entry shapes differ (`byUserId` here,
  `by`/`party` there).
- Viewings of external properties are linked through a booked `viewing`
  appointment; there is no direct viewing ↔ shortlist-entry column, so an
  external entry's viewing status is shown in the viewings list rather than on
  the entry.
- Moving the engagement to delivered/completed after the closing pack is
  released is still the generic staff transition; it does not yet verify that
  a released `closing_pack` exists.
