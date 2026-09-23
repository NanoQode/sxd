# SimplexD property portal — Claude Code build instructions

Prepared 22 September 2026. This is an implementation specification for replacing the public website and building its backend, customer portal, admin portal and partner workspaces. It is not a claim that the application has already been implemented.

## 1. Mission and delivery contract

You are the lead product engineer building SimplexD, a Nigerian property services and oversight platform serving Nigerians at home and abroad. Implement the complete application described here, with a working database, authentication, permissions, business workflows, integrations, responsive interface, tests and deployment documentation. Deliver working vertical slices rather than an attractive mockup with disconnected buttons.

Read this entire brief and the accompanying `nigeria-50-markets.seed.json` and `DATA-RESEARCH-NOTES.md` before coding. Inspect the repository and retain useful existing assets. If the repository is empty, initialize the proposed architecture. Create `IMPLEMENTATION-STATUS.md` mapping every numbered module to implemented, tested, blocked by credentials, or outstanding. Update it after each milestone. Never mark a feature complete because its screen exists.

The user confirmed that the map should cover **50 major property markets**, balancing geography and property relevance, rather than a strict population ranking. It must cover **contractor bidding deadlines, construction timelines and approval timelines** separately. There is no evidence-backed national investment league table in this handoff; do not call the seed an official ranking.

Develop locally and in staging, using provider sandboxes. Do not switch the live domain or process live payments until the release process and operational setup are complete. Missing credentials must produce an honest setup state and a documented dependency, never fabricated success. Continue independent implementation while those dependencies are unresolved.

## 2. Business baseline and positioning

The current [SimplexD homepage](https://simplexd.co/) advertises eight services: construction monitoring, due diligence, architectural services, property management, virtual inspections, purchase support, property search, and land sales/leasing. It targets remote owners and busy local professionals. Its [pricing page](https://simplexd.co/pricing/) presents indicative starting prices and custom quotations, not universally fixed fees. Individual service pages were not retrievable during this review; the workflows below are proposed product requirements rather than claims about existing operations.

Seed these editable service price anchors from the homepage: monitoring NGN 150,000; diligence 100,000; architecture 250,000; management 75,000/month; virtual inspection 50,000; purchase support 1.5%; search 80,000; land sales/leasing by quotation. Store basis, minimum scope, exclusions, effective date and publication status. Require business review before migration publication. Never calculate a purchase-support invoice without an agreed percentage basis and signed scope.

Position the product around verifiable evidence and clear next actions. Preserve the brand name and obtain approved logos/photography from the existing site or owner. Do not automatically carry over marketing statistics, testimonials, nationwide operational availability, partner badges or project claims without owner evidence and publication rights. Map coverage and actual service availability are separate fields.

## 3. Product surfaces, routes and navigation

Build four connected surfaces with one identity system:

| Surface | Core routes | Purpose |
|---|---|---|
| Public website | `/`, `/services`, `/services/[slug]`, `/locations`, `/locations/[slug]`, `/properties`, `/properties/[slug]`, `/projects`, `/pricing`, `/diaspora`, `/local-nigeria`, `/resources`, `/about`, `/contact`, `/book` | Discover, compare, understand and start a transaction |
| Customer portal | `/portal`, `/portal/properties`, `/portal/projects`, `/portal/requests`, `/portal/documents`, `/portal/invoices`, `/portal/appointments`, `/portal/messages`, `/portal/settings` | Manage owned or shared work and take decisions |
| Admin | `/admin` with operations, customers, services, projects, properties, market data, tenders, suppliers, finance, content, integrations, access and audit sections | Operate the business and control publication |
| Partner workspace | `/partner` with assignments, bids, reports, delivery notes, invoices and availability | Restricted work for contractors and professionals |

Tenant/renter access lives in a restricted customer experience. Staff inspectors use a mobile-friendly partner/staff assignment view. Do not show every module to every role.

Public header: Services, Explore Locations, Properties, How It Works, Resources; clear Book Consultation and Sign In actions. Group the eight services inside an accessible mega-menu. On mobile use a compact drawer, a visible search action, and a contextual sticky primary action. Preserve deep links and browser navigation across map, list and filters.

## 4. UX, visual design, animation and themes

Use a clean architectural visual language: warm neutral surfaces, charcoal text, forest/teal primary accents, restrained gold highlights, generous space, legible typography and real Nigerian project imagery. Implement reusable design tokens; confirm actual brand assets before finalizing colors. Avoid large stock-image collages and distracting auto-playing effects.

Public pages should feel welcoming; portals should prioritize dense but readable work. Use a consistent page title, short explanation, primary action, filters and content hierarchy. Dashboard cards must answer: what changed, what needs me, what is due, and what happens next? Every KPI opens its underlying records.

Implement Light, Dark and System preferences on **public website, customer portal, admin and partner surfaces**. Default to system, persist anonymous preference locally and authenticated preference to the user profile. User choice overrides organizational default. Render the correct theme on first paint without a bright flash. Theme charts, map style, menus, uploads, editors, dialogs and empty states, not only the page background. Provide a clearly labeled sun/moon/system control. Admins may set brand defaults but must not silently overwrite a user's preference.

Animations: 120–180 ms hover/press feedback; 180–250 ms dropdown and dialog transitions; gentle map transitions; subtle progress and upload feedback. These are design targets, not rigid requirements. Animate opacity and transforms; prevent layout shifts. Respect `prefers-reduced-motion`, with an in-app Reduce Motion preference. No scroll hijacking, required hover interactions, flashing effects, endless bouncing calls to action or animations that delay form completion.

Target WCAG 2.2 AA: keyboard navigation, visible focus, semantic controls, accessible dialog focus trapping/restoration, meaningful labels, error summaries, contrast, text scaling and minimum 44 px practical touch targets. Use icons plus words for status; never color alone. Tables have mobile cards or horizontal scrolling with retained row labels. A screen-reader-friendly list must offer the map's complete functionality.

Build loading, empty, partial, stale, unauthorized, offline, success and failure states for each module. Use skeletons only while actual loading occurs. Autosave long forms with visible save status. Preserve input after validation/network failure. Destructive actions need contextual confirmation; routine saves should not. Currency uses NGN with readable naira formatting. Store timestamps in UTC and display Africa/Lagos plus the customer's chosen time zone for appointments. Use explicit date formats such as 22 Sep 2026.

## 5. Public homepage and conversion journey

Homepage order:

1. Concise value proposition and two actions: Explore Where to Build and Book a Consultation.
2. Interactive Nigeria location explorer visible near the top; a lightweight static outline/list loads before the interactive map bundle.
3. Eight service cards with concrete deliverables and editable starting prices.
4. Goal paths: Buy Safely, Build with Oversight, Manage My Property, Invest and Compare.
5. How the service works, approved case studies, sample redacted reports and evidence standards.
6. Customer stories only when approved; FAQs; consultation form; useful footer.

Allow anonymous map exploration and basic estimates. Ask for an account to save a plan, share privately, request professional validation or start a service. Carry selected cities, filters, budget and scenario into the consultation or quote request rather than asking the customer to repeat them. Use short progressive forms. Track conversion with consent-aware analytics, excluding private documents and payment details.

## 6. Homepage Nigeria map and recommendation engine

### 6.1 Interaction

Use MapLibre GL JS with a licensed tile provider, visible attribution, configurable keys and proper Nigeria boundaries. Never use public community tile servers as an unlimited production backend. The engine supports point locations and optional neighborhood/market polygons in PostGIS. GeoJSON uses longitude then latitude, WGS84. Do not fabricate boundaries from city points.

Desktop: filter column, map, selected location panel and comparison tray. Mobile: map/list switch, filter sheet and accessible location bottom sheet. Cluster nearby markers; zoom into clusters. Keyboard users access an equivalent results list. Map errors fall back to that list, with retry.

Filters: objective (owner occupation, long-term rent, development for sale, student housing, commercial, short stay), total budget, land area in square metres, floor area, asset type, bedrooms/units, quality specification, target completion, minimum projected net yield, preferred regions, risk tolerance and evidence freshness. Additional optional filters include power/water provision, internet, transport access, schools, hospitals, flood exposure, soil investigations and service-team availability. Unknown is a real filter value.

Users may adjust scoring priorities, compare up to four locations, save scenarios, generate a dated comparison report and request local verification. Comparisons show underlying units, evidence dates, confidence and geographic scope. A statewide observation must be labeled statewide context, not silently presented as a city value. Lagos metro overlaps Ikeja/Ikorodu; do not add overlapping populations, listings or demand totals.

### 6.2 Location panel

Show city/state/zone, short editable profile, map position, service coverage status, indicative market observations if available, neighborhood drill-down, verified material suppliers and quotation dates, tender opportunities, expected project schedule under the user's assumptions, forecast rent/cash flow, environmental checks and actionable next steps. Include “Why this matches”, “Missing evidence” and “Last reviewed”.

Data badges: sourced observation, verified operational record, regional context, model estimate, user assumption, unknown, stale, disputed. Never use one generic Verified label for all of these. A city can be visible while not eligible for financial ranking.

### 6.3 Ranking contract

Build a deterministic, versioned service, not an LLM choosing cities. Initial configurable weights: affordability 25%, material delivery/access 15%, net rental economics 20%, construction duration 10%, approval duration 10%, evidence-backed demand 10%, infrastructure/site suitability 10%. These are proposed product defaults, not researched investment truths. Tender closing dates are schedule constraints and a separately visible factor; a short bidding window is not automatically desirable.

Normalize eligible observations using fixed, versioned policy bounds appropriate to the selected property cohort. Lower costs and shorter relevant durations score higher. Define metric direction, unit, approved lower/upper anchors and clamping in the admin policy. For a higher-is-better metric, `s = clamp((x-low)/(high-low),0,1)`; reverse for lower-is-better. Invalid or equal bounds disable that metric with an admin error. Do not change score bounds when a user pans the map.

For weights w, metric scores s and confidence multipliers c in [0,1]: `fit = 100 * sum(w*s*c)/sum(w*c)` over eligible metrics. Separately report `coverage = sum(w for available eligible metrics)/sum(all selected w)`. Confidence has an explicit source-quality, freshness, geographic-match and sample-size rubric. Multipliers are configuration, not hidden AI judgments. No score if the denominator is zero.

For an investment ranking require locally applicable cost AND rental inputs, plus at least 70% weighted coverage. Do not treat statewide mixed-property medians or unverified production-plant leads as eligible inputs. Missing values must not become zero prices or perfect scores. Below the threshold, show “More local data needed”, list what is missing and permit assumption-driven scenario comparison in a visibly separate mode. For owner-occupier goals omit yield and renormalize the saved weights. Rank by eligible fit, then confidence, then a stable identifier. Explain the top contributing metrics.

Hard constraints: approved geographic exclusions, total budget ceiling where cost evidence is valid, legal/title stop flags on specific listings and site restrictions. Unknown flood or title status is not low risk. Show inability to assess rather than certifying safety. Sponsored placements must be separate, labeled and cannot alter fit scores. Store policy version, inputs and source versions with every saved recommendation.

### 6.4 Financial calculations

All calculators are scenarios, not guaranteed valuations or investment advice. Support low/base/high input sets and sensitivity charts for vacancy, rents, costs, interest and completion delays. If required inputs are absent, return null with a reason; do not invent Nigerian averages.

`total_development_cost = land + acquisition_costs + build_cost + professional_fees + approvals + utilities_and_external_works + contingency + financing_during_build`.

`build_cost = gross_floor_area_m2 * approved_build_rate_ngn_per_m2`, or a priced BOQ when available. Never add a BOQ to the area-rate estimate. Explain inclusions such as roof, finishes and external works. Plot sizes vary: require actual m² and never assume every plot is 600 m². Area conversion retains the original declared unit.

For long lets: `scheduled_annual_rent = sum(units * annual_rent_per_unit)`; `effective_income = scheduled_annual_rent*(1-vacancy_rate)*(1-collection_loss_rate) + other_annual_income`; `NOI = effective_income - recurring_operating_expenses`; `gross_yield = scheduled_annual_rent/total_development_cost*100`; `net_yield = NOI/total_development_cost*100`; `cash_flow_after_debt = NOI - annual_debt_service`. Label the denominator as development cost. For a purchase scenario use total acquisition basis instead. Show cash-on-cash only with an explicit equity denominator.

Operating expenses separately include management fees, maintenance, insurance, service costs, unrecoverable charges and an explicit tax assumption supplied/reviewed by the business. Prevent charging a management percentage twice. Distinguish pre-tax and after-tax outputs. Debt service is not an NOI expense. Capex reserves are shown separately or explicitly included consistently. Simple payback is undefined when net cash flow is non-positive. No yield when the cost denominator is zero.

Short stays use available nights, occupied-night percentage, nightly rate, platform charges, cleaning and operating costs. Never multiply nightly asking rent by 365 and call it expected revenue. Keep short-stay cohorts separate from annual leases. Phase cash flows monthly; completion delays postpone rental start. NPV/IRR expansion requires an explicit discount rate, exit value, selling costs and complete dated cash flows; label failed/non-unique IRR solutions.

Unit-test example, entirely hypothetical: 2 units at NGN 3m/year, 10% vacancy, zero collection loss, NGN 1.2m annual operating expenses and NGN 100m total cost produces NGN 6m scheduled rent, NGN 5.4m effective income, NGN 4.2m NOI, 6% gross yield and 4.2% net yield. These are test assumptions, not seeded city prices.

### 6.5 Three separate timeline systems

**Bidding:** tender release, site visit, question cutoff, answer publication, submission deadline, evaluation and award. Authoritative server timestamps, displayed time zones, explicit deadline extensions and versioned addenda. Atomic deadline checks; no late acceptance through a stale browser. Contractors cannot see competitors' bids. Sealed bids remain inaccessible to evaluators until closing except audited authorized procedures.

**Construction:** dependency graph for design, investigations, approvals, site preparation, foundations, structure, roof, services, finishes, inspection and handover. Each task stores duration/range, dependencies, calendar, lead times, actuals and accountable party. Compute the critical path with parallel activities; reject dependency cycles. Weather, delivery, scope change and site access are explicit scenario assumptions. Baseline revisions retain history.

**Approvals:** jurisdiction, authority, permit/document type, completeness date, application reference, fees, queries, resubmissions and decision. Historical actual durations must define start/end and whether elapsed or business days. Display statutory targets separately from observed processing times. Do not impose a fabricated national “permit in X weeks” default. All three timelines have editable templates and source/assumption notes.

## 7. Seed data and market-data administration

Import the accompanying JSON as researched geography and limited contextual evidence. It contains 50 locations, source registry, shared state-level observations where found, city observations where found, supply-facility leads and explicit data gaps. It intentionally does **not** claim verified rents, building rates, approval times or delivered-material availability for every location. Read the research notes before rendering any price or ranking.

Use immutable source observations and separately versioned editorial interpretations. Every observation must include metric, numeric value/range or categorical value, unit, currency, geographic scope, property cohort, statistic type, observation period, source URL, retrieved date, sample size when available, collection method, verification status, reviewer, valid-until and license/use notes. Retrieval date is not the observation date. Never overwrite historical data during refresh.

Admin workflows: create/edit/archive/restore cities and neighborhoods; move a point on a map with coordinate validation; merge duplicates with references preserved; import JSON/CSV with preview and row-level errors; export data; add sources; attach local survey evidence; edit review dates; approve/reject observations; compare revisions; publish/unpublish; rollback; set ranking policies and service coverage independently. Use optimistic concurrency and a separate approver for financially material published changes. Immutable audit entries show before/after and reason.

Accept regional context but do not clone it into 50 city price rows. Add neighborhoods under stable city IDs. Do not delete locations with linked projects: archive them. Published changes invalidate relevant caches and recalculate future recommendations while old saved reports retain their snapshots.

Proposed freshness policy, editable by data type: material quotes 14 days or supplier expiry, rents/sales 90 days, official risk layers until next valid edition, observed permit performance 180 days. Stale records remain inspectable but are excluded from default ranking. An official report's own validity takes precedence. Collect sufficient independent comparables before publishing local medians; start with a configurable rule of at least 10 deduplicated comparable listings, with source concentration disclosed. This is a publication policy, not a statistical guarantee.

Research queue for each market: obtain local property comparables, current supplier quotations including delivery, architect/quantity-surveyor cost estimates, relevant approval authority evidence and site-level environmental checks. Never scrape prohibited sources, republish contact details without a lawful purpose, bypass login or imply a license for full commercial ingestion merely because a page is public.

## 8. Eight core service modules

All services share inquiry → triage → scoped quotation → customer acceptance → invoice/payment where required → assigned work → evidence/review → customer delivery → completion → feedback. Variations are allowed but must be deliberate state transitions with permissions. Rejected, paused and canceled paths need reasons and appropriate billing consequences.

| Module | Required working features | Completion evidence |
|---|---|---|
| Construction monitoring | Project baseline, BOQ, budget commitments/actuals, milestone plan, site visits, photos/video/drone uploads, progress reports, defects, material checks, change orders, owner approvals | Versioned reviewed report, unresolved issues list and milestone acceptance |
| Due diligence | Property intake, title/document checklist, survey references, legal/surveyor assignments, site findings, queries, red flags and decision memorandum | Named professional reviewer, evidence references and clear scope/limitations; no automatic legal guarantee |
| Architecture | Brief, site information, design options, drawings, revisions, comments, approvals tracker, BOQ and professional handoffs | Customer signoff on a versioned deliverable and revision history |
| Property management | Properties/units, leases, rent schedules, collections, arrears, maintenance, recurring inspections, owner statements and tenant tickets | Reconciled period statement and open obligations |
| Virtual inspections | Appointment, checklist, photos/video, optional live meeting, annotated findings, defect severity, report export | Reviewed inspection report and customer access |
| Purchase representation | Search criteria, shortlist, offers, negotiation log, conditions, diligence dependency, closing checklist and document handover | Approved closing pack and agreed fee basis |
| Property search | Requirements, saved searches, shortlist comparison, alerts, viewing bookings and feedback | Accepted shortlist or documented search outcome |
| Land sales/leasing | Owner authority, parcel/area, title disclosures, media, listing moderation, inquiry qualification, offers and lease milestones | Authorized listing and documented transaction/lease outcome |

Evidence uploads store capture time, uploader, checksum and optional GPS separately from server receipt time. EXIF/GPS is user-provided evidence, not proof of authenticity. Retain restricted originals, generate compressed derivatives, and publish only approved/redacted versions. Large media uploads must be resumable and processed asynchronously. Customer approval of a milestone is distinct from an inspector's progress estimate and finance's payment authorization.

## 9. Service expansions to implement

These are a broad, practical expansion portfolio, not claims that SimplexD already supplies them or that every possible future business line has been enumerated. Implement the core workflows in release waves; use feature flags for controlled activation. Keep unstaffed services unavailable for booking with an honest inquiry option.

| Expansion | Product workflow | Commercial/operational model |
|---|---|---|
| Contractor tendering | Scope/BOQ, qualification, sealed submissions, clarifications, weighted evaluation, award, variations, performance | Tender-management fee; disclosed partner relationships |
| Materials procurement | Supplier directory, RFQs, normalized units, delivered-cost comparisons, PO, delivery evidence, discrepancies, returns | Procurement service fee or disclosed margin |
| Quantity surveying | Versioned estimate, BOQ, valuation, cost-to-complete and change control | Professional assignment and scoped fee |
| Independent snagging | Pre-handover checklist, defects, accountability, reinspection and closure | Per inspection or package |
| Renovation/retrofit | Existing-condition survey, option comparison, budget, tender and monitored delivery | Project fee using existing project engine |
| Preventive maintenance | Asset register, warranty dates, recurring work orders, contractor dispatch and SLA reporting | Subscription or work-order pricing |
| Facilities/estate management | Shared assets, service charges, resident issues, visitor-policy integration hooks and statements | Estate contract, separate accounting by estate |
| Rental placement | Listing, viewings, applications, consent-based screening, offer, lease and move-in inventory | Agreed placement fee |
| Student housing | Bed/unit inventory, academic-period lease schedules, guarantors and maintenance | Specialist management package |
| Short-stay management | Calendar/inventory, booking requests, turnover tasks, expenses and owner statement | Management contract; channel-manager connector as later integration |
| Commercial/industrial property | Property-type specific search, fit-out requirements, leases and compliance checklist | Mandated search/management assignment |
| Landowner/developer matching | Opportunity profile, controlled data room, proposals and adviser review | Introductions/mandate fee with conflict disclosure |
| Investment feasibility | Saved market comparison, cost/rent scenarios, sensitivity and reviewed feasibility report | Paid professional report |
| Energy/water upgrades | Load/condition survey, solar/water options, quotes, installation evidence and warranty | Vendor-managed project package |
| Insurance/finance referrals | Customer consent, partner referral, document handoff and status tracking | Disclosed referral arrangement; no loan approval promises |
| Valuation referrals | Purpose, property details, qualified valuer assignment and report | Qualified professional's scoped service |
| Portfolio reporting | Consolidated ownership, rent, expenses, project exposure, geographic mix and export | Owner/institutional reporting subscription |
| Diaspora concierge | Time-zone-aware coordinator, delegated approvals, evidence digests and family access | Service tier with explicit SLA |
| Professional partner network | Credentials, coverage, availability, conflict disclosures, reviews and expiry | Verified membership/assignment; badge states what was checked |
| Market intelligence | Licensed/first-party data collection, trend views, methodology, alerts and exports | Subscription research product after adequate coverage |
| Dispute support | Evidence chronology, issue tracking and professional referral | Administrative case support; no automated legal decision |
| Document renewals | Expiry reminders, document requests and professional processing tasks | Renewal-support package |
| AI-assisted operations | Draft report summaries, classify defects for human review, search authorized documents | Optional assistive feature with provenance and opt-out |

Do not activate pooled investment, fractional ownership, customer-fund wallets, escrow custody, lending or automated legal certification as ordinary portal features. Represent their possible expansion through feature-flagged referral/data-room workflows only until an appropriate operating model, providers and professional review are established. No “escrow” badge for ordinary gateway payments. Customer rents collected on an owner's behalf are liabilities/payables, not SimplexD service revenue.

Every expansion shares access control, tasks, evidence, billing and audit infrastructure. Do not build 23 unrelated mini-applications. Feature flags must hide both interface and unauthorized endpoints; retain old records when a feature is disabled.

## 10. Customer, tenant and partner experiences

Customer onboarding captures verified email, optional phone, preferred time zone, goals and individual/company ownership. Collect sensitive identity documents only when the chosen transaction requires them. Allow invited household members/advisers to join with explicit view, comment or approval rights. One person can belong to multiple customer organizations; switching organization must reset cached private data.

The customer home shows tasks awaiting approval, upcoming visits, invoices due, latest reports, budget changes and assigned contact. Users can request services, compare/accept quotes, pay invoices, inspect payment status, approve or reject change orders, annotate plans, upload documents, book/reschedule meetings, message their team, export reports and manage notifications. Saved location scenarios remain accessible and can become service requests.

Property detail: overview, units/leases, projects, documents, financials, inspections and timeline. Project detail: overview, schedule, budget, reports, media, defects, decisions and team. A timeline is an audit-aware activity view, not a replacement for structured records. Avoid exposing internal staff notes to customers; every note has an explicit visibility scope.

Tenants can view only their lease, balances, receipts, maintenance tickets, appointments and approved notices. They cannot see the owner's entire portfolio or other tenants' information. Tenant invitations have expiry and revocation. Public application forms have abuse controls.

Contractors see invited tenders, their own submissions and awarded assignments. Inspectors see assigned visit instructions and can save field-report drafts; offline capture shows unsynced state and encrypts sensitive local storage where supported. Do not cache private document libraries in a public service worker. Vendors see their RFQs, orders and delivery disputes. Legal/survey partners access only assigned evidence and findings. Staff must approve customer-facing reports before release where the workflow requires review.

## 11. Admin console and permission model

Admin navigation: Overview; CRM/Leads; Customers; Properties; Projects; Service Requests; Assignments; Reports; Tenders; Procurement; Rentals/Maintenance; Finance; Appointments; Messages; Market Data; Content; Partners; Integrations; Settings; Audit.

Admin functionality includes lead assignment, service availability by location, SLA queues, workload/calendar, quotation templates, pricing, report templates, document requirements, notification templates, content publication, portfolio analytics, refunds, payment reconciliation, support escalation and integration health. Saved table views, bulk actions with previews, searchable global navigation and exports make operations efficient. Finance exports must reconcile to underlying records.

| Role | Allowed scope | Explicit exclusions |
|---|---|---|
| Super administrator | Organization settings, roles, provider setup, break-glass operations | No routine sharing of secrets or bypass without audit |
| Operations manager | Staff assignments, workflow overrides, service delivery | Cannot change payment credentials without separate permission |
| Project manager | Assigned projects, budgets, requests and report review | No unrelated client access |
| Inspector | Assigned visits, draft findings, uploads | Cannot release funds or approve own final report by default |
| Finance | Invoices, reconciliation, authorized refunds, owner statements | No unrestricted legal/identity-document access |
| Data editor | Draft locations, sources and observations | Cannot publish own material price/ranking changes |
| Data approver | Review/publish data and score policies | No silent deletion of history |
| Content editor | Pages, media and SEO drafts | No private project documents or payment access |
| Support | Assigned customer tickets and limited profile | Masked finance/identity fields, no unrestricted impersonation |
| Customer owner/member | Own organization and granted properties/projects | No cross-organization access |
| Tenant | Own lease and tickets | No owner ledger or other tenants |
| Partner | Invited bids and explicitly assigned work | No competitors' submissions or other assignments |

Implement granular permissions and resource relationships, not just role strings. Default deny. Enforce authorization on every server mutation, query, search, export, attachment download, background job and real-time subscription. UI visibility alone is never authorization. Support impersonation, if implemented, requires explicit permission, reason, prominent banner, expiry and audit; forbid secret access and financial approvals during impersonation. Require MFA for staff with finance, access, data-publication or integration permissions.

## 12. Payment gateway and accounting

Implement Paystack first through a provider interface; leave documented adapters for future gateways rather than misleading selectable options. Admin can configure provider, test/live mode, public key, write-only secret, webhook URL, supported currency and enabled payment purposes. Customer funds use supported hosted checkout/payment components so card details never pass through SimplexD servers. Integration must follow the current [Paystack payment guide](https://paystack.com/docs/payments/accept-payments/).

Create payment attempts on the server from an authorized invoice with an immutable amount/currency/reference. Store NGN as integer kobo, not floating-point currency. A browser redirect is not settlement. Verify on the server that provider status, reference, amount and currency match the expected attempt before allocating funds. Include an explicit uncertain/pending state and reconciliation job. See [verification documentation](https://paystack.com/docs/payments/verify-payments/).

For Paystack webhooks, verify HMAC SHA512 against the exact raw body and secret using constant-time comparison. Durably record and deduplicate authentic events before acknowledgement, then process through a queue. Replays, simultaneous callback/webhook processing and retries cannot create duplicate allocations, receipts or entitlements. See [webhook documentation](https://paystack.com/docs/payments/webhooks/).

Invoice lifecycle: draft, issued, partially paid, paid, overdue, void; credit notes and refunds are separate records. Payment attempts: initialized, pending, successful, failed, reversed. Refunds: requested, approved, submitted, pending, settled, failed. Chargebacks create reconciliation tasks and appropriate ledger entries without destroying original history. Do not mark a provider refund settled from a successful submission alone.

Use a balanced journal for money movements, with unique business-event references and immutable posted entries; corrections reverse rather than edit. Separate customer receivables, service revenue, gateway clearing, fees, refunds, rent liabilities and owner distributions. Document accounting treatment with the business accountant. Invoice tax/withholding treatment is configurable and reviewed; do not assume one tax percentage applies to every service or rental. Gate payouts behind reconciliation and dual approval; ordinary service checkout does not authorize arbitrary partner transfers.

Support deposits, installments, agreed recurring management fees, receipts, credit notes, bank-transfer reconciliation with finance approval, and exports. Do not count an uploaded transfer receipt as cleared money. Document gateway account activation and enabled payment channels as external setup requirements. Refund and integration settings changes require step-up authentication. Display meaningful customer errors without leaking provider secrets.

## 13. SMS provider configuration

Implement Termii behind `SmsProvider`, following its current [Messaging documentation](https://developers.termii.com/messaging). Admin fields: API credential, supported base endpoint/profile, approved sender ID, environment, enabled message purposes, template versions, sending limit, delivery-report configuration and test recipient. Re-check current endpoint/authentication details during implementation; do not assume old SDK examples still apply.

Use E.164 phone normalization, consent/preference records, transactional versus marketing categories, approved sender registration, language/template previews, estimated segments/cost and delivery state. Queue messages with retry/backoff, deduplication and spend caps. Distinguish accepted by provider from delivered. Inspect delivery receipts; keep provider IDs and sanitized errors. SMS failure must not reverse a completed business transaction. OTPs, if used, expire, have attempt limits and are never logged. Prefer authenticator-based staff MFA; SMS should not be the only privileged-account protection.

Marketing opt-out and suppression lists apply across campaigns. Transactional messages contain minimal private information and link to authenticated content. Templates include booking confirmation/reminder, visit changes, invoice due, report ready and urgent decision required. Test-send is a permission-controlled action with a visible recipient, not an automatic message to every customer during setup.

## 14. SMTP configuration and notifications

Implement a server-side mail adapter with configurable SMTP hostname, port, implicit TLS or STARTTLS mode, username, encrypted password, sender name/address, reply-to and approved sender domains. Require secure transport in production; never disable certificate checks to make tests pass. SMTP connection settings and stored secrets must not be shipped to the browser.

Admin tools: connection test, explicit test email, template preview, send log, failure reason, retry queue and domain setup checklist for SPF, DKIM and DMARC. Credentials never appear in diagnostic responses. Restrict server-side connection destinations to permitted SMTP providers/endpoints; block localhost, internal network and cloud metadata access through these settings to prevent SSRF. Local Mailpit is permitted only in development mode.

Build branded HTML and plain-text templates. Events go through a transactional outbox with idempotent notification jobs. Preference controls cover email, SMS and in-app alerts; essential security messages follow explicit product policy. Add daily/weekly digest options with customer time zones and quiet hours for nonurgent notifications. In-app notifications link to authorized records. SMTP acceptance is not delivery confirmation; show delivery only when supported provider feedback proves it. Handle bounce/complaint suppression where the configured service exposes it.

## 15. Google Calendar and Google Meet

Build real OAuth integration configurable inside Admin → Integrations → Google Workspace. Admin supplies Google Cloud client ID and write-only secret or their secret-manager references, sees exact redirect URI, connects an authorized organizer, chooses calendar, grants minimum required scopes and configures working hours, consultation duration, buffers, holidays, cancellation policy and staff routing. A client ID/secret alone is not a connected calendar; show the OAuth grant and token health separately.

Use server-side OAuth authorization code handling with state/CSRF protection and current supported Google security guidance. Encrypt refresh tokens and restrict scopes. Revoke/disconnect, handle token refresh, expired grants and `invalid_grant` with reconnect instructions. Customers do not need to connect their own Google accounts to book. Domain-wide delegation is not the default.

Read free/busy without exposing external event titles. Combine Google conflicts, platform appointments, staff leave, buffers and booking holds. Use expiring holds and a database exclusion/locking mechanism so concurrent requests cannot reserve the same staff slot. Recheck availability before confirmation; handle the residual external-calendar race with conflict reconciliation rather than claiming a distributed atomic guarantee.

Create the event with attendees and time zones. Generate a distinct Meet conference via `conferenceData.createRequest`, a new request ID for a new booking, `hangoutsMeet` and `conferenceDataVersion=1`. Conference creation can be asynchronous; poll/reconcile status before displaying a Join button. Preserve the same request identity when retrying the same operation and prevent duplicate events. Store event ID, calendar ID, booking ID, sync version and confirmed meeting URL. See [Google Calendar event reference](https://developers.google.com/workspace/calendar/api/v3/reference/events).

Rescheduling updates the linked event and reminders; cancellation cancels the appointment and associated calendar event, releases capacity and notifies relevant attendees. Use event version checks for conflicts. Implement incremental sync/push notification handling with channel-token validation and renew expiring watch channels; a push notice triggers an authenticated fetch, not blind acceptance of event details. Reset sync safely when tokens become invalid. Reference [Google push notifications](https://developers.google.com/workspace/calendar/api/guides/push).

Show business and customer time zones with DST-aware conversions. Provide calendar download as a fallback when Google is unavailable; keep provider sync visibly pending and do not invent a Meet link. Meet is joined externally in a new tab; embedding a functioning full Meet client is not required. Recording/transcription is a separate future feature with explicit consent and account capability checks. Store private meeting URLs only for authorized participants. Admin has a test-booking tool and can cancel its test event.

## 16. Integration administration and secrets

All integrations expose disconnected, configured-unverified, connected, degraded, expired and disabled states, last successful check, credential last rotation, current environment, sanitized logs and remedial action. Save settings, test settings and activate settings are distinct operations. Never show “Connected” merely because a form saved.

Store secrets in a managed secret vault where available or envelope-encrypt with an external KMS/master key; database backups alone must not reveal plaintext credentials. Secret fields are write-only and display masked presence/last-change metadata. Restrict access, audit changes without secret values and support rotation. Key changes use a verification period and rollback-safe versioned configuration. Keep test and production secrets, webhook origins and data completely separate.

The same dashboard controls map tile provider and optional geocoding provider, storage integration, allowed upload sizes, retention policies, notification templates, ranking configuration and feature flags. Do not expose arbitrary code execution, unrestricted URLs or SQL as “configuration”.

## 17. Technical architecture

Use a TypeScript modular monolith initially: Next.js App Router for public/portal/admin UI and versioned HTTP endpoints; a separate Node worker process for asynchronous work; PostgreSQL with PostGIS; Redis and a durable job queue; private S3-compatible object storage. Use a maintained authentication library/provider with organization membership, session controls and MFA, rather than inventing authentication cryptography. Pin compatible supported versions when implementation starts and commit a lockfile. Reference [Next.js docs](https://nextjs.org/docs/app) and [MapLibre docs](https://maplibre.org/maplibre-gl-js/docs/).

Recommended UI tools: Tailwind-style tokens, accessible headless components, schema-validated forms, a table library, lightweight motion library and chart library. Equivalent maintained tools are acceptable when documented. Use a database access layer that supports explicit transactions and PostGIS queries, with reviewed parameterized SQL for spatial operations. Do not require microservices to launch.

Suggested organization:

```text
apps/web/                 # public, portal, admin and versioned API
apps/worker/              # jobs, reports, media and integration sync
packages/domain/          # policies, calculations and state transitions
packages/db/              # schema, migrations, RLS and seed importer
packages/ui/              # components and theme tokens
packages/integrations/    # payment, SMS, mail, Google, storage and maps
packages/contracts/       # validation schemas and API contracts
data/                     # reviewed seed and source metadata
tests/                    # unit, integration, permissions and end-to-end
docs/                     # architecture, operations and provider setup
```

Use server-authoritative totals, permissions, deadlines and transitions. Browser forms are convenience checks only. Validate all inputs, allow-list sortable fields, paginate queries, limit uploads and protect endpoints against abuse. Public cache keys must never include private responses; private data is not cached across customers. Every mutation supports conflict handling where concurrent edits matter. Jobs inherit an explicit organization/resource identity and recheck authorization/context where relevant.

Persistent outbox records are committed in the same transaction as the business event. Workers retry with backoff and bounded attempts, move exhausted jobs to a dead-letter queue and expose retry/reconciliation tools. Financial and scheduling actions are idempotent. Do not run important long jobs after a request without durable persistence. Use structured sanitized logging, correlation IDs and distributed error tracking.

## 18. Data model and APIs

Core entities and constraints:

| Domain | Entities and relationships |
|---|---|
| Identity | User, Organization, Membership, Role, Permission, Session, Invitation, Consent, Preference; unique membership per organization/user |
| Geography | Country, State, Market, Neighborhood, Geometry, ServiceCoverage; stable IDs, aliases, geographic level and overlap relationships |
| Intelligence | Source, Observation, ObservationRevision, Review, SupplyFacility, SupplierCoverage, SupplierQuote, RankingPolicy, Scenario, RecommendationSnapshot |
| CRM/services | Lead, Service, Package, ServiceRequest, Quote, QuoteVersion, Acceptance, Assignment, Task, SLA |
| Property | Property, Parcel, Unit, Listing, ListingRevision, OwnerAuthority, Offer, Viewing, SavedSearch; private asset separate from public listing |
| Project | Project, BudgetVersion, BOQItem, ScheduleTask, TaskDependency, Milestone, SiteVisit, Report, ReportRevision, Evidence, Defect, ChangeOrder, Approval |
| Commercial | Tender, TenderRevision, Invitation, Bid, BidRevision, Evaluation, Award, RFQ, PurchaseOrder, Delivery, Discrepancy |
| Rental | Lease, LeaseParty, RentSchedule, RentCharge, RentAllocation, WorkOrder, Asset, Warranty, OwnerStatement |
| Finance | Invoice, InvoiceLine, PaymentAttempt, ProviderEvent, Allocation, CreditNote, Refund, Journal, JournalLine, Reconciliation |
| Communications | Appointment, BookingHold, CalendarConnection, EventSync, Conversation, Message, Notification, Template, DeliveryAttempt |
| Platform | FileObject, FileAccessGrant, IntegrationConfig, SecretReference, AuditEvent, ContentPage, Redirect, FeatureFlag, Outbox, JobFailure |

Operational entities have `organization_id` plus resource ownership/assignment. Central business staff access is granted through explicit staff policy; customer organizations cannot edit globally published market data. Require foreign keys, unique external references and currency-consistent allocations. Use row-level security where practical plus application policies; migrations/test users must validate tenant isolation. Financial entries and audit events are append-only. Use archive/status semantics instead of cascading deletion of evidence.

Representative versioned endpoints (extend with all module operations):

```text
GET    /api/v1/markets?bbox=&objective=&evidenceStatus=
GET    /api/v1/markets/:id/observations
POST   /api/v1/recommendations
POST   /api/v1/scenarios
POST   /api/v1/service-requests
POST   /api/v1/quotes/:id/accept
GET    /api/v1/projects/:id
POST   /api/v1/projects/:id/reports
POST   /api/v1/change-orders/:id/approve
POST   /api/v1/files/upload-intents
POST   /api/v1/files/:id/finalize
POST   /api/v1/invoices/:id/payment-attempts
POST   /api/v1/webhooks/paystack
GET    /api/v1/appointments/availability
POST   /api/v1/appointments/holds
POST   /api/v1/appointments
POST   /api/v1/appointments/:id/reschedule
POST   /api/v1/tenders/:id/bids
POST   /api/v1/admin/market-imports/preview
POST   /api/v1/admin/observations/:id/publish
POST   /api/v1/admin/integrations/:provider/test
```

Document request/response schemas with OpenAPI. Return stable error codes and human-readable messages, correlation ID, validation details and retry guidance when applicable. Use cursor pagination for activity streams and stable pagination for tables. Idempotency keys bind to requester, endpoint and request-body hash; reject conflicting reuse. Enforce server-side ownership before returning files or updating records. Supply safe date/currency/decimal serialization contracts.

## 19. Security, privacy and operational reliability

Threat model cross-customer leakage, forged payments, forged evidence, account takeover, malicious file uploads, stored XSS, SSRF via integrations, unauthorized bid access and accidental disclosure in exports. Use secure HttpOnly/SameSite cookies, CSRF protections, HTTPS, CSP, output encoding, input validation, rate limits, password/session policies and MFA. Scan dependencies and secrets before release.

Private uploads use time-limited signed URLs, size/MIME validation, malware quarantine and explicit access checks. A failed scanner leaves the object quarantined. Prevent SVG/HTML/script uploads from executing in the app origin. Redact sensitive documents and precise property coordinates from public listings unless approved. Logs must not contain tokens, identity files, raw payment secrets or private message content.

Design consent, lawful-purpose records, retention/deletion/export processes, audit controls and incident response with the [Nigeria Data Protection Act](https://ndpc.gov.ng/download/nigeria-data-protection-act-2023) and applicable customer jurisdictions in mind. Obtain appropriate professional review of launch policies rather than claiming software automatically makes the business compliant. A deletion request may require restricted retention of accounting/legal records; document the policy and communicate the outcome.

Back up the database and object metadata, enable appropriate point-in-time recovery, encrypt backups and conduct a restore drill. Proposed service objectives: 99.5% monthly application availability, 24-hour maximum backup recovery point until stronger recovery is configured, and 4-hour restore target; verify the selected hosting can meet them. Monitor queue lag, webhook failures, failed syncs, storage errors, low provider balance and overdue reviews. Business dashboard counts are derived from actual records, not hardcoded demo numbers.

## 20. CMS, search, migration and SEO

CMS manages services, packages, FAQs, location introductions, resources, approved projects, testimonials, contact details, navigation, banners, policy pages and SEO metadata. Draft/review/publish, scheduled publication, preview links, revisions and rollback are required. A content editor cannot inject arbitrary scripts or access private evidence through the media picker.

Public properties support type, price, area, location, tenure/title disclosure, availability and verification-scope filters. Never imply every listing is legally verified. Badge detail identifies what was checked, by whom and when, with expiry. Moderate owner authority and listing content before publication. Distinguish duplicate listings and expired availability. Use server-rendered indexable detail pages, canonical URLs, sitemap, robots controls and accurate structured data. No fabricated review schema.

Crawl and inventory the current site when implementation begins. Preserve approved URLs or create tested 301 redirects. Migrate only authorized content with image rights, retain metadata and create a reconciliation report. Noindex private portals, previews and incomplete location pages. Preserve analytics identifiers only when authorized and compatible with consent choices. Cutover includes backup, smoke checks, DNS plan and rollback, with no unreviewed replacement of the live website.

## 21. Release waves and measurable acceptance

These waves organize the complete scope. Do not silently reduce the final project to Wave 1. Nonactivated regulated expansions remain deliberately gated as described above.

| Wave | Deliverable | Exit condition |
|---|---|---|
| 0 | Repository, architecture decisions, schema, design tokens, auth, permissions, local services, CI | Reproducible install; migrations and cross-organization denial tests pass |
| 1 | Public website, all 50 map points, evidence panels, calculators, saved scenarios, CMS and customer requests | Anonymous exploration → saved scenario → service request works; unknown data handled honestly |
| 2 | Eight service workflows, customer/staff/partner portals, uploads, budgets, reports and approvals | A complete service engagement can be run without manually editing the database |
| 3 | Payments/ledger, SMS, SMTP, Calendar/Meet, admin configuration and operational logs | Sandbox integration journeys and failure/retry paths pass; real account setup documented |
| 4 | Tenders, procurement, rentals, maintenance and expansion workflow templates | End-to-end business journeys and permission checks for each activated module pass |
| 5 | Accessibility, performance, security, migration, restore rehearsal, documentation and release | Acceptance report, unresolved-dependency list and signed release readiness |

Required acceptance scenarios:

1. A visitor filters 50 locations, switches map/list, compares four markets and saves a scenario; reload preserves it. Unknown data never yields an invented price or zero-cost winner.
2. A data editor adds a 51st market, imports observations and submits review; an approver publishes. Public data updates; old reports preserve their source snapshots; rollback is audited.
3. A customer requests diligence, receives/accepts a versioned quote, pays in sandbox and receives a reviewed report. Another customer cannot access any of those IDs or files.
4. A contractor submits a bid before closing, cannot revise after closing, cannot see a competitor's submission and receives the award decision only when published.
5. A project change order cannot alter the approved budget until customer/staff approvals required by policy are present; variance and forecast reflect approved changes.
6. Duplicate, delayed and reordered payment events do not double-allocate money. Invalid signatures, mismatched currencies/amounts and uncertain refunds do not produce settled invoices or credits.
7. Two users compete for one appointment slot: only one wins. Google/Meet setup failure is visible and retryable. Reschedule and cancellation synchronize, including across DST boundaries.
8. Admin configures SMTP/SMS, performs explicit test sends, sees real success/failure and delivery distinctions, rotates a secret and confirms it never appears in API payloads or logs.
9. Owner sees an accurate lease/rent statement; tenant sees only their obligations. Maintenance request → assignment → evidence → approval → expense works.
10. Inspector loses connection during fieldwork, sees unsynced state and resumes safely without duplicating reports or leaking files to another signed-in user.
11. All surfaces work in light/dark/system and reduced motion; keyboard navigation and map fallback complete key journeys at 360 px mobile width and desktop.
12. A file with an unsupported type or failed malware scan is unavailable; signed download expires; revoked membership immediately prevents fresh access.
13. Backup restore reproduces financial balances, users, project records and object references in a clean environment.
14. Every visible button either performs a working action, explains a real setup dependency or is intentionally hidden by feature flag. No dead controls or fake dashboards.

Test pure calculation and ranking edge cases, state-machine permissions, ledger balancing, tenant isolation and critical-path cycles with unit/integration tests. Use Playwright or equivalent for high-value journeys and accessibility automation plus manual keyboard review. Test migrations against a clean database and a previous schema snapshot. Test provider adapters with contract fixtures and sandbox calls; fixture tests alone do not prove live credentials work.

Performance targets: public-page p75 LCP ≤2.5s, INP ≤200ms, CLS ≤0.1 under representative mobile conditions; measure field performance after launch and document lab conditions before it. Lazy-load the map and video; keep initial navigation usable on slow networks. Proposed load acceptance: 100 concurrent browsing users and realistic background work without data leakage or failed core writes; report environment and measured results rather than promising unsupported capacity.

## 22. Required handoff from Claude Code

Deliver source code, lockfile, database migrations, validated idempotent seed import, environment variable example without secrets, local Docker Compose dependencies, worker startup, integration setup guides, admin/customer quick-start guides, OpenAPI specification, permission matrix, test report, accessibility/performance evidence, deployment/rollback guide, backup restore procedure and known limitations.

Local development must start with documented commands and development-only accounts created by a seed or setup command. No hardcoded production admin password. Provide a secure first-admin bootstrap flow and disable demo seeding in production. Local payment/SMS/Google adapters may simulate responses only in explicitly labeled development mode. Production cannot silently fall back to mocks.

External launch inputs: approved brand assets and copy; company/domain ownership; hosting/database/storage accounts; payment merchant approval and keys; SMS account and sender approval; SMTP account and DNS records; Google Cloud OAuth configuration and organizer consent; map tile account; appointed operational staff/partners; locally reviewed prices and data publication rights. Track these as dependencies without blocking unrelated work.

At completion, report what actually runs, which tests passed, which integrations were exercised against a real sandbox, which credentials/operational approvals remain, and whether the market dataset has enough evidence to activate rankings. A populated map with transparent gaps is acceptable; claiming 50 researched financial profiles when those inputs are absent is not.
