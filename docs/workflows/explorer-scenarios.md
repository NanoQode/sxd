# Location explorer: anonymous exploration and account-gated scenarios

The Nigeria location explorer (`/` compact, `/explore` full; `apps/web/src/components/explorer`,
`apps/web/src/lib/explorer`) implements brief §5 and §6: anyone may explore the map, filter the
fifty markets, compare up to four and run calculator estimates. Saving a plan, sharing it
privately, requesting local verification, starting a service and generating a dated comparison
report ask for an account.

## The `core.anonymous_scenarios` flag

Seeded **off** (`packages/db/src/seed/reference.ts`). Administrators may switch it on in the admin
feature flags to allow server-side saves owned by the `sx_anon` cookie (up to 20 per visitor,
claimable after sign-in). Existing databases keep their stored value: the seed never overwrites a
flag, so a deployment seeded before this default must switch it off by hand if it wants the gate.

| Action                              | Anonymous, flag off | Anonymous, flag on            | Signed in |
| ----------------------------------- | ------------------- | ----------------------------- | --------- |
| Explore, filter, compare, calculate | yes                 | yes                           | yes       |
| Save scenario / Generate report     | sign-in first       | yes (anonymous, cookie-owned) | yes       |
| Request local verification          | sign-in first       | yes                           | yes       |
| Start a service                     | sign-in first       | yes                           | yes       |
| Share link (private, expiring)      | sign-in first       | sign-in first (server rule)   | yes       |

The decision is the pure `decideScenarioAction` in `lib/explorer/account-gate.ts`; the explorer
context's `requireAccount(action)` applies it and performs the side effects.

## What happens on a gated action

1. The local draft (assumptions, scenario name, priorities, mode, compared markets;
   `lib/explorer/draft-storage.ts`) is written immediately, not on the debounce.
2. The visitor is sent to `/sign-in?next=<explorer URL>` where the explorer URL carries every
   query parameter (filters, `compare`, `mode`, `view`, `priorities`, selected `market`) plus
   `resume=<action>` (`save`, `share`, `verify`, `service` or `report`). The sign-in and
   sign-up pages read the intent (`lib/explorer/resume-intents.ts`, dependency-free so server
   components can use it) and say what will happen after sign-in.
3. After sign-in the explorer page renders with `access.signedIn` (resolved by the server page
   from the request identity, `components/explorer/access.ts`), restores filters and comparison
   from the URL and the rest from the draft, consumes `resume` from the URL and re-opens the
   action:
   - `save`: the save dialog opens pre-filled; one click completes the save. Nothing is saved
     silently.
   - `share` / `service`: the same confirming save dialog opens; on save the private share link
     is created (and shown or copied) or the visitor continues to `/book?scenario=…`.
   - `verify`: the verification request form opens (it saves the scenario when sent).
   - `report`: the comparison dialog opens; "Generate dated comparison report" saves and
     snapshots.

Cancelling any dialog drops the intent. A reload never repeats it (the URL no longer carries
`resume`); an anonymous visitor arriving with `resume` (an abandoned sign-in) just sees the
restored state.

The hint under the scenario actions states the rule for the current flag state. Sign-in and
sign-up links from the explorer carry `next` so the state is never lost.

## Location panel honesty (brief §6.2)

- **Tender opportunities** come from real tenders: open (`published`/`clarifications`,
  deadline ahead on the database clock) tenders linked to the market through
  `projects.marketId`, the project's `properties.marketId` or `service_requests.marketId`
  (`server/markets/tenders.ts`). Tenders are never public: staff with `tenders.manage` or
  `bids.evaluate` see all, invited partners theirs (with a link to `/partner/tenders/{id}`),
  customers their organisation's. The tenders a caller may see are read under the caller's own
  row-level security context; only their market links are resolved with the policy bypass
  (a partner cannot read the customer's project row). Anonymous visitors get the honest text
  that tenders are invitation-based; a disabled `expansion.contractor_tendering` says so.
- **Verified supplier quotations** are written when a purchase order is issued
  (`server/procurement/supplier-quotes.ts`, called from `issuePurchaseOrder`): one
  `supplier_quotes` row per order line for the RFQ's delivery market, dated by the supplier's
  submission, `reviewStatus: verified` (a real accepted price, badge "verified operational
  record"), `rankEligible: false` (ranking eligibility stays a business review decision), with
  the order and RFQ references and the whole-order delivery cost in the terms text. Quantities
  are stated in the supplier's unit only when they match the order unit or a declared
  conversion exists; otherwise they stay unknown.

## Tests

- Unit: `lib/explorer/account-gate.unit.test.ts` (gate decisions, URL/draft round-trip),
  `components/explorer/location-panel.unit.test.ts`,
  `server/procurement/supplier-quotes.unit.test.ts`.
- Integration: `server/markets/tenders.int.test.ts`, `server/procurement/procurement.int.test.ts`.
- End to end: `tests/e2e/specs/scenario-1.spec.ts` (acceptance scenario 1 and the 360 px
  keyboard journey) and the explorer journey in `journeys.spec.ts`, which saves as the demo
  customer. Both need the demo seed with `core.anonymous_scenarios` off.
