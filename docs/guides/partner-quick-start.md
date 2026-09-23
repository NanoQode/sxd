# Partner and inspector workspace: quick start

The workspace at `/partner` is for contractors, vendors and professional partners (a `partner_profiles` row) and for staff inspectors or anyone holding a live assignment. Everyone else is sent to `/portal`. Every page and every API call checks its own permission. The navigation only hides modules that do not apply to you, so a hidden item is never what protects the data.

Code: `apps/web/src/app/(partner)`, `apps/web/src/components/partner`, `apps/web/src/lib/partner`.

## Who sees what

| Account                                                            | Modules                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------ |
| Contractor, architect, quantity surveyor                           | Tenders & bids (when `expansion.contractor_tendering` is on) |
| Vendor                                                             | RFQs & orders (when `expansion.materials_procurement` is on) |
| Inspector, surveyor, valuer, architect, QS; staff `inspector` role | Visits (field capture), Evidence, Reports                    |
| Legal partner                                                      | Evidence, Reports                                            |
| Everyone                                                           | Home, Assignments, Messages, Notifications, Availability     |

`other`-type partners see every module. The rules live in `lib/partner/nav.ts`. A contractor's awarded work arrives as an assignment, and each accepted assignment card links to that project's visits, evidence and reports.

The header badge shows what was verified, as recorded on the partner profile: status, the scope of the check, when it was done, the expiry date and any individual credentials. If the profile does not record something, the badge says so rather than implying it. Staff accounts show "Staff account".

## Contractors: tenders and bids

1. **Tenders & bids → Invited tenders.** Each deadline is shown in the tender's own time zone and in UTC. The countdown uses the server clock, learned from the `Date` header of API responses. Until the first response arrives it uses the device clock and says so.
2. **Tender page.** Accept or decline the invitation. Declining asks for confirmation and closes the bid workspace. Scope documents open through short-lived signed links (`GET /api/v1/files/{id}/download` with `Accept: application/json`) and are never cached. You can ask clarification questions until the question cut-off. You see your own questions and every answer staff publish.
3. **Bid workspace.**
   - "Start a bid" creates a private draft.
   - Enter priced lines in naira (for example `1,250,000.50`). Amounts are converted to integer kobo strings without floating point, and the total follows the lines unless you override it. Add duration and qualifications.
   - "Save revision" stores an unsubmitted revision. Unsaved edits are kept in this tab's session storage, and the status shows it.
   - "Submit bid" sends the content with the revision. The server decides the deadline inside one atomic update. A late submit returns `deadline_passed` and changes nothing: an earlier submission stands exactly as it was.
   - Before the deadline you can re-submit, or withdraw with a reason. Withdrawal is final.
4. **Awards** appear only after staff publish them. You then see your outcome (awarded or not) and can accept or decline the award. Declining asks for confirmation. Competitors' bids are never shown.

## Vendors: RFQs, orders and deliveries

- **RFQ page.**
  - Price each item in your own unit.
  - When your unit differs from the RFQ unit, you must declare the conversion ("1 bag = 0.05 tonne"). It is sent as `declaredConversion` with `basis: supplier_declared`, and staff may re-measure it.
  - Add the delivery charge, lead times and a validity date, then save a draft or submit before the deadline.
  - Withdrawal asks for confirmation and is final.
  - You only ever see your own response.
- **Purchase orders.** Acknowledge an issued order with your reference and expected delivery date.
- **Deliveries & disputes.** See what the site recorded, line by line, and any discrepancies raised against the order.

## Inspectors and assigned partners: field capture offline

1. **Assignments.** Accept, or decline with an optional reason. Accepted project assignments link to that project's Visits, Evidence and Reports.
2. **Visits.** Lists the visits where you are the named inspector, with their time zone, UTC and status. "Capture" opens the visit, calls `/start` for a scheduled visit, and immediately saves the instructions and checklist to the device so they can be read offline.
3. **Capture.**
   - Fill in the checklist (you can add items), findings (required by the server), weather and access notes.
   - Add photos with the camera input (`<input type=file accept=image/* capture=environment>`).
   - Optionally record the device position. It is labelled as user-provided and not proof of presence, both on screen and in the payload.
   - Everything autosaves to the device ("Saved on device …").
4. **Losing the connection.**
   - The header shows **Offline** and **N unsynced**, and a banner asks you to keep the tab open.
   - Sync is disabled, and capture continues against IndexedDB.
   - On the Visits page, drafts open in place ("Continue draft"), with no page navigation, so this works offline.
5. **Sync** (when back online) runs these steps and saves progress after each one:
   1. For each photo: `POST /api/v1/files/upload-intents` → `PUT` to the signed URL → `POST /api/v1/files/{id}/finalize`.
   2. Once the visit id is known, link each photo with `POST /api/v1/projects/{id}/evidence`, including its caption, capture time and user-provided GPS. The offline id is `${visitOfflineId}:${fileId}`, the same key the server's own visit sync uses.
   3. `POST /api/v1/site-visits/sync` with the draft's `offlineClientId`. `created` and `replayed` both confirm the visit. `rejected` keeps the draft and shows the server's code and reason.
   4. Photos of a visit created in the field are linked once the server has returned the visit id.

   Retrying never duplicates anything: visits replay on their offline id and evidence on its link key. A photo whose malware scan is still running stays "Uploaded, scan pending" and the draft is "Partly synced"; sync again later. Only an actual API refusal (a 4xx response) marks a photo or visit rejected. Network errors, 401, 408, 429 and 5xx leave everything on the device.

6. **Clearing.** A draft is removed from the device only when the server has confirmed the visit and every photo is linked. A photo the server refuses keeps the draft and shows the reason until you remove that photo.
7. **Unscheduled visits.** Staff inspectors can start one from a project ("Start a field visit"); the visit is created when you sync. Partners cannot: the server lets only staff create visits in the field, and the page says so.
8. **Reports.** Report drafts are kept on the device and encrypted the same way.
   - "Create on server" is idempotent on the draft's offline id.
   - "Save revision to server" skips posting when the latest server revision already matches, which covers a response that was lost.
   - "Submit for review" names the reviewer, pre-filled with the project manager. There is no reviewer-directory API for partners, and the page says so.

### Offline storage design and its limits

- **Namespacing.** IndexedDB database `sxd-partner-offline` has two stores, `drafts` and `photo_bytes`. Keys start with `userId|offlineClientId`, and listings go through a `userId` index. A different user on the same device lists nothing of the previous user's.
- **Encryption.** Findings, checklist, notes, GPS, instructions, photo captions and photo bytes are encrypted with AES-GCM (WebCrypto) under a random 256-bit key per user and per browser session. A fresh IV is used for every write. Only the title, ids, timestamps and sync state stay in clear text, so lists can render.
- **Where the key lives.** The key is kept only in the tab's `sessionStorage`. When a user opens the workspace, any other user's key left in the tab is purged. Sign-out discards the user's own key, and warns first if there are unsynced drafts.
- **What survives.** A reload in the same tab and loss of connection both keep the key. Closing the tab or browser, opening another tab, or signing out makes existing drafts **locked**: they can be discarded but not read or synced. Sync before closing the browser.
- **What it does not protect against.** It protects data at rest against a later user of a shared device. It does not protect against malware running while your session is open.
- **When a draft cannot be stored.** If WebCrypto or session storage is unavailable, drafts are not stored at all, and the page says so. If IndexedDB is unavailable (for example in some private windows), drafts live only in memory, and the page says so.
- **No service worker, on purpose.** Nothing private is cached for offline use, and `/api` responses and documents are never stored. This means a full page reload, or moving to another page while offline, needs the network. Offline work happens inside the open tab.

## Messages, notifications, availability

- **Messages.** Reply in conversations you take part in. Attachments open through signed links. Starting a new conversation is not available to partners: the API needs participant ids and a linked entity, so staff open threads, and the page says so.
- **Notifications.** A feed of your notifications, with unread-only filter, mark read, mark all read and deep links.
- **Availability.** Edit your weekly windows: ISO weekday (Monday = 1), `HH:mm` start and end in a chosen time zone, and optionally the appointment kinds a window serves (none ticked means any). Saving sends `PUT /api/v1/appointments/staff/{yourUserId}`; overlapping or inverted windows are caught before sending. You can add leave or a block (`POST …/time-off`) and remove it with confirmation (`DELETE …/time-off/{id}`). A period that overlaps an appointment, hold or other time off is refused with `slot_unavailable`, and the page says so. Partners can edit only their own availability (`partner.availability.manage`). The partner-profile status (set by staff) is shown alongside.

## Known gaps (API side)

- **Bid attachments.** Uploaded with the `partner_submission` purpose: the file belongs to you, is scanned before use, and SimplexD evaluators can read it only after the sealed bid is opened.
- **Discrepancies.** Suppliers can read them but not respond; only staff move them between states. The page points to Messages.
- **No partner-wide visit list.** Visits are gathered per project from `/api/v1/projects/{id}/site-visits` and filtered to the named inspector.
- **Large photos.** Multipart uploads (over 64 MB) are not handled in field sync. Such a photo is refused, with the reason shown.

## Local smoke test

```bash
pnpm --filter @simplexd/web seed:demo          # demo accounts, password DemoPassword-2026!
set -a; source .env; set +a
APP_URL=http://localhost:3106 PORT=3106 pnpm --filter @simplexd/web dev
```

The demo seed creates accounts and profiles, not projects. Create the rest as staff: a project, then assignments, site visits for `inspector@` and `surveyor@`, a published tender inviting `contractor@`, and an issued RFQ. Tendering and procurement stay hidden until their expansion flags are on; toggling a flag needs an MFA-verified super admin. Uploaded files become linkable only after the worker's malware scan passes. Set `APP_URL` to the port you serve on, because signed upload URLs are built from it.

Unit tests:

```bash
pnpm --filter @simplexd/web exec vitest run --project web-unit src/lib/partner src/components/partner
```
