# Listings, moderation, public search, inquiries, offers and land transactions

Server workflows behind `/api/v1/listings/**`, `/listing-offers/**`, `/admin/listings/**` and
`/public/listings/**` (code in `apps/web/src/server/listings`, contracts in
`packages/contracts/src/listings.ts`, OpenAPI in `apps/web/src/lib/api/registry/listings.ts`,
state machines `listingMachine` and `listingOfferMachine` in
`packages/domain/src/workflow/machines.ts`, expiry job in `apps/worker/src/handlers/listings.ts`).
This is the land sales/leasing service of the brief (§8): owner authority, parcel/area, title
disclosures, media, listing moderation, inquiry qualification, offers and lease milestones, with
"authorised listing and documented transaction/lease outcome" as completion evidence.

Every mutation runs in one transaction under the caller's row-level-security context, checks the
permission catalogue plus the resource relationship (default deny), records an audit event with
before/after state, refuses stale writes through `listings.version` (or the negotiation-log length
for offers), and appends an outbox event that the notification registry turns into an owner or
moderator notification. Prices are optional integer kobo (decimal strings on the wire) and are
never estimated: an empty price reads "price on request".

## Who may do what

| Actor                                                          | Reach                                                                                                                                                                                   |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner organisation member with `org.listings.manage`           | Create, revise, submit, withdraw, re-confirm availability; respond to offers (counter, accept, reject); record lease milestones and the outcome.                                        |
| Owner organisation member with `org.read`                      | Read the organisation's listings, offers and transaction panel.                                                                                                                         |
| Buyer organisation member with `org.requests.create`           | Make an offer on a live sale or lease listing; counter, accept or withdraw on the buyer's turn. Never on the organisation's own listing.                                                |
| Staff with `content.publish` (content editor, super admin)     | Moderation decisions: publish a specific revision, reject, request changes, mark duplicate. Matches the `listing` workflow machine.                                                     |
| Staff with `rentals.manage` (operations, finance, super admin) | Verify owner authorities (existing), record verification checks (what, outcome, by whom, when, until when), progress milestones and record outcomes on the owner's behalf, run the job. |
| Staff with `customers.read`                                    | Read listings and offers (support sees them, decides nothing).                                                                                                                          |
| Staff with `leads.read`                                        | See the inquiries raised from a listing (in CRM and on the listing page).                                                                                                               |
| Anonymous visitor                                              | Search live listings, read a live listing, send an inquiry, load approved photos.                                                                                                       |

Row-level security is the second net: a draft of another organisation is invisible (`not_found`),
offers are visible to the two organisations and staff only, and the public site reads through the
system context exposing only public-safe fields (never the address, owner, organisation or
contact details).

## Listing lifecycle

1. **Draft (revision 1).** `POST /api/v1/listings` for one of the organisation's active
   properties: kind (sale, lease, short stay), title, description (Markdown; images and scripts are
   stripped, links get `rel="nofollow ugc"`), optional price with a basis (outright, per year, per
   month, per night, per plot, per m²), area m², tenure (Land Use Act vocabulary), title
   disclosure text, availability (`now` or a date), media (clean image files of the organisation,
   never identity documents) and public location precision (`state`, `market` (default),
   `neighborhood`, `exact`). Neighbourhood precision needs a neighbourhood on the property record
   and exact precision needs coordinates.
2. **Revise.** `PATCH /api/v1/listings/{id}` with `expectedVersion` creates revision N+1; earlier
   revisions are kept. Staff verification checks are carried forward untouched (the owner can never
   write them). Allowed in draft, rejected, in moderation, published and expired; refused once a
   listing is withdrawn, closed or marked as a duplicate.
3. **Submit for moderation.** `POST /api/v1/listings/{id}/submit` requires a **verified,
   unexpired owner authority** for the property (`422 insufficient_evidence` otherwise) and moves
   the listing to `in_moderation`. A published listing with newer changes stays live on its approved
   revision while the changes are reviewed; an expired listing is re-submitted by the same call
   (re-confirmation triggers moderation, as the machine states).
4. **Moderation** (`/admin/listings`, decisions need `content.publish`):
   - _Approve_ publishes one specific revision (`revisionVersion` must be the current one; a newer
     save means staff review that instead), re-checks the owner authority, requires
     `approveExactLocation` when the revision asks for coordinates, sets `publishedVersion`,
     `publishedAt`, `availabilityConfirmedAt` and `expiresAt` (90-day window,
     `LISTING_AVAILABILITY_WINDOW_DAYS` in `server/listings/rules.ts`), and records the
     owner-authority check (verifier, date, expiry) on the revision's verification scope.
   - _Reject_ (reason required): a never-published listing becomes `rejected`; a live listing keeps
     its approved revision and returns to `published` with the reason as the moderation note.
   - _Request changes_ (reason required): back to `draft`, or to `published` for a live listing.
   - _Mark duplicate_: sets `duplicateOfListingId`, moves the listing to `rejected` (never
     published) or `withdrawn` (was live). Duplicates never show publicly and cannot be resubmitted;
     their public URL points at the original while that is live.
   - _Verification checks_ (`rentals.manage`): `POST .../verification-checks` appends what was
     checked (owner authority, title document sighted, registry search, survey plan sighted, site
     visit, photos compared with the site), the outcome (passed, issue found, inconclusive), the
     staff member, the date and an expiry to the current revision and to the published one when it
     differs. Checks are appended, never rewritten.
5. **Live.** Owners re-confirm availability (`POST .../confirm-availability`) to restart the
   window, withdraw with a reason (`POST .../withdraw`; drafts are archived instead), and see the
   inquiry count and offers.
6. **Expiry.** The hourly job `listings.expire_lapsed` (worker; on demand through
   `POST /api/v1/admin/listings/expiry-runs`) marks published listings past `expiresAt` as
   `expired`, audits each and emits `listing.expired`; public pages already hide a listing from the
   moment its window closes. The same run lapses open offers past their validity date.
7. **Outcome.** `POST .../outcome` records sold, leased or withdrawn (see below) and closes the
   listing (`archived`) or withdraws it.

Every staff decision is audited (`listing.published`, `listing.rejected`,
`listing.changes_requested`, `listing.marked_duplicate`, `listing.verification_check_recorded`,
`listing.expired` by the job) and emits the matching outbox event; the notification registry
(`packages/notifications/src/registry.ts`, `listingResolvers`) sends the owner organisation an
`activity_update` (email + in-app) for publication, rejection, change requests, duplicates and
expiry, tells moderators (content editors, operations, super admins) about submissions and
recorded outcomes, and tells the owner in-app when an inquiry arrives.

## Public properties pages

`/properties` lists published, non-duplicate listings inside their availability window (60-second
cache, invalidated on every publication-affecting change) with filters for listing type, property
type, price range (whole naira, compared as stated on each listing's own basis; listings with no
stated price never match a range), area range, state and market (options come from the live set),
tenure, title-disclosure presence, availability now and "verification check passed" (an unexpired,
passed check of that kind). Unknown or malformed filter values are ignored and reported, never an
error page (`server/listings/filters.ts`, unit tested). `GET /api/v1/public/listings` returns the
same set as JSON.

`/properties/{slug}` is server-rendered with a canonical URL, `RealEstateListing` structured data
carrying only stated facts (price when given, place at the approved precision, approved photos;
no reviews or ratings), the description, a verification panel that states exactly what was
checked, the outcome, by whom, on which date and until when (expired checks are marked), a plain
notice that the panel is not a legal verification, the inquiry form and the "make an offer" link.
The location is shown at the approved precision only: state; market and state; neighbourhood too;
or coordinates (5 decimals) when exact publication was requested by the owner and approved by
staff. Photos are served through `GET /api/v1/public/listings/{slug}/media/{fileId}`, which
redirects to a short-lived signed URL of a publicly approved derivative (`is_public_approved`,
clean, on the published revision); originals are never served.

**Expired, withdrawn, closed and duplicate listings** render an honest "no longer available" page
(title and reason category only, no price or form) with `noindex, follow`; the API returns HTTP
410 for the same slugs. Listings that were never published are indistinguishable from unknown
slugs (404). App Router pages cannot set a 410 status themselves, so the page relies on `noindex`
and the sitemap (which lists live listings only); the JSON endpoint carries the 410.

## Inquiries

`POST /api/v1/public/listings/{slug}/inquiries` creates a CRM lead (source `website_form`,
interest service land sales/leasing) whose `context` carries `kind: 'listing_inquiry'`, the
listing id, slug, title and the visitor's interest. Abuse controls match the consultation form:
5/hour per hashed IP, 3/hour per email, a honeypot and a too-fast heuristic that mark the lead as
`spam` for review without telling the visitor. Staff qualify inquiries in `/admin/leads` (the lead
page links to the listing) and see them on `/admin/listings/{id}`. The owner sees a count and the
time of the last inquiry only; contact details stay with SimplexD staff until they introduce the
parties through the engagement.

## Offers and negotiation

`POST /api/v1/listings/{id}/offers` records an offer that belongs to the buyer's organisation with
the listing owner's organisation as counterparty (both see it through RLS; a third organisation
gets `not_found`). Amount, conditions, note and an optional validity date are stored; the first
negotiation-log entry is written with it. `POST /api/v1/listing-offers/{id}/actions` takes
`counter`, `accept`, `reject` or `withdraw` with `expectedEntries` (the log length the caller saw):

- `submitted` (the buyer's figure is on the table): the owner may counter, accept or reject; the
  buyer may withdraw;
- `countered` (the owner's figure is on the table): the buyer may counter, accept or withdraw; the
  owner may reject.

Each step appends `{at, by, party, action, amountKobo, note}` with a JSON concatenation in SQL;
earlier entries are never rewritten, a stale `expectedEntries` or a concurrent status change is
refused with `version_conflict`, staff read but never act, and expired offers take no action.
Acceptance links the offer to the listing's land transaction request when one is tracked and
notifies the other party; it is not a contract: completion is documented through the engagement.

## Land transaction: milestones and outcome

The transaction is the owner organisation's **land sales/leasing service request** (workflow
template `land_sales_leasing`, requested from the portal like any service). Milestones and the
outcome are `engagement_items` on that request:

- `POST /api/v1/listings/{id}/lease-milestones` adds a milestone (kind `lease_milestone` for
  lease and short-stay listings, `closing_task` for sales; `subjectType = 'listing'`) with a due
  date and reference. The first item names the request; every later item must use the same one.
  `PATCH .../lease-milestones/{itemId}` moves it (open, in progress, satisfied, waived, failed,
  cancelled; a note is required to waive, fail or cancel) with evidence files and `expectedVersion`.
- `POST /api/v1/listings/{id}/outcome` records **sold**, **leased** (evidence files and the
  request required; the listing closes as `archived`) or **withdrawn** (reason; the listing moves
  to `withdrawn`) as a satisfied `closing_task` with `subjectType = 'listing_outcome'` and
  `reference` = the outcome, optionally naming the accepted offer. One outcome per listing.

`GET /api/v1/listings/{id}/transaction` returns the linked request, the open land requests that
could be linked, the milestones, the outcome and the accepted offer. Staff complete the service
request through the normal engagement workflow with this evidence.

## Tests

- `apps/web/src/server/listings/listings.int.test.ts`: submission refused without a verified,
  unexpired authority; another organisation cannot see or edit a draft; moderation publishes a
  specific revision and the public set shows it at the approved precision only (exact needs
  explicit approval; a live listing stays public while changes are reviewed); duplicates and
  expired listings are excluded and explained; rejection keeps the listing private with the reason;
  verification checks (rentals.manage only) feed the public filter and survive owner edits; the
  offer negotiation log is append-only and visible to both parties only; milestones and a
  documented outcome close the listing; the expiry job expires listings and offers with audit and
  outbox events.
- `apps/web/src/server/listings/inquiries.int.test.ts`: the inquiry route creates a lead with the
  listing reference, flags honeypot submissions, refuses non-live listings and invalid payloads and
  rate limits an address.
- `apps/web/src/server/listings/filters.unit.test.ts`: filter parsing, matching and sorting.

The fixtures (`server/listings/testing/fixtures.ts`) never truncate the shared test database;
every row carries a unique suffix and `cleanup()` removes what was inserted.

## Known gaps

- Photos are shown publicly only after a staff member approves the file for public use
  (`POST /api/v1/files/{id}/public-approval`, evidence.approve or content.media.manage); the
  listing pages report which attached photos are approved, but approval itself happens per file
  from the file tooling, not from the moderation page.
- Staff cannot act on an offer for a party (purchase representation records its own offers).
- Pausing a live listing (the `paused` state of the machine) has no endpoint; owners withdraw or
  let the window lapse instead.
- Sharing an inquirer's contact details with the owner is done through the engagement
  (conversation or assignment), not from the listing page.
