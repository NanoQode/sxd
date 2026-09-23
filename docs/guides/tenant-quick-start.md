# Tenant portal: quick start

The tenant area at `/tenant` is for renters linked to a lease. It shows only the tenant's own lease, balances, receipts, maintenance requests, appointments and the notices addressed to them. It never shows the owner's portfolio, the owner ledger (management fees, statements, payouts) or another tenant's records. The tenant API enforces this (`/api/v1/tenant/**`, see `docs/workflows/rentals-and-maintenance.md`); the screens only request the caller's own data.

Code: `apps/web/src/app/(tenant)`, `apps/web/src/components/tenant`, `apps/web/src/lib/tenant`.

## Getting access

1. The landlord (owner organisation) or staff invites the tenant on the lease: `POST /api/v1/leases/{id}/parties` with the tenant's name and e-mail. The invitation is single use and expires after 1–30 days (7 by default).
2. The e-mail links to `/tenant/invitations/accept?token=…`. A visitor who is not signed in is sent to sign-in first, which also links to create an account. They come back to the invitation afterwards.
3. The invitation page shows the property, unit, role, lease dates and expiry, and whether the signed-in address is the invited one.
   - **Wrong account:** the page says so and offers "Sign out and use the invited email".
   - **Expired:** the page says so. The landlord has to send a new invitation.
   - **Already used, revoked or replaced:** the service clears the token in all three cases, so the page cannot tell them apart. It says exactly that, and links to the tenant home if the account already has a lease.
4. **Accept invitation** calls `POST /api/v1/tenant/invitations/accept`. On success the tenant lands on `/tenant` with a confirmation. When the landlord revokes access, the lease disappears from the tenant area at once.

A signed-in account with no active tenancy sees an explanation of how to get invited, not an error.

## Pages

| Page                      | What it shows                                                                                                                                                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/tenant`                 | Current lease (active first, then the latest), balance due and overdue part, next charge, open maintenance requests, upcoming appointments, the latest notices. Every figure links to its records.                                                                                                                       |
| `/tenant/lease/{id}`      | Terms (rent, deposit, dates, type, notice period, academic terms), the tenant's own party record, the rent schedule, the signed lease document and move-in inventory photos when shared with the tenant, and the move-in inventory. `/tenant/leases/{id}` redirects here.                                                |
| `/tenant/balances?lease=` | Outstanding, overdue, next charge, paid to date, deposit held; arrears ageing (not yet due, 1–30, 31–60, 61–90, over 90 days); invoices issued to the tenant for the lease; every charge with paid and outstanding amounts.                                                                                              |
| `/tenant/receipts`        | Receipts for confirmed payments on the tenant's invoices.                                                                                                                                                                                                                                                                |
| `/tenant/tickets`         | Maintenance requests the tenant reported, open first.                                                                                                                                                                                                                                                                    |
| `/tenant/tickets/new`     | Report a problem: lease (when there are several), category, short title, description and priority, with the response target of each priority.                                                                                                                                                                            |
| `/tenant/tickets/{id}`    | Status in plain words, progress steps, the dates the record holds, the contractor's name once assigned, photos from the work if shared. **Cancel this request** (reason required) while the request is received, reviewed, assigned or awaiting owner approval. Costs and estimates are owner matters and are not shown. |
| `/tenant/appointments`    | Visits booked with the tenant, upcoming first, in Lagos time and in the tenant's own time zone when it differs.                                                                                                                                                                                                          |
| `/tenant/notices`         | Notices from the landlord or SimplexD, newest first, with **Mark as read**.                                                                                                                                                                                                                                              |

## Behaviour you can rely on

- **Failures stay contained.** Each section loads on its own. A failed section shows what is missing, a support reference (also written to the server log) and **Try again**, and the rest of the page still renders.
- **Forms keep what you typed.** After a validation, network or server failure the input stays. Errors are listed at the top and linked to their fields. A second submit is blocked while one is in flight.
- **Money and dates.** Amounts are integer kobo from the API, shown as naira without floating-point arithmetic. Dates without a time (due dates, lease dates) are shown as written, for example `22 Sep 2026`, and are never shifted by a time zone.
- **Accessibility.**
  - Light, dark and system themes and the reduce-motion switch from the shared shell.
  - A skip link.
  - Every status shows an icon and words.
  - Progress steps mark the current step for screen readers.
  - Tables have captions and turn into labelled cards on narrow screens.
  - Touch targets are at least 44 px and the layout works at 360 px.

## Known limits (API gaps)

- **Paying rent online.** The finance API accepts payment attempts only from members of the invoice's organisation with `org.invoices.pay`, and rent invoices belong to the owner organisation. A tenant is the invoice's `customerUserId` but not a member, so `POST /api/v1/invoices/{id}/payment-attempts` refuses them. The balances page therefore shows no Pay button to tenants. Instead it explains how to pay the landlord directly; the payment appears once it is recorded. For an account that does hold `org.invoices.pay` on the owner organisation, each payable invoice links to `/portal/invoices/{id}`, which runs the payment attempt, checkout and verified-result flow. Hosted checkout returns to the portal invoice page in any case, because the callback redirects there.
- **Ticket photos.** Tenants cannot upload files for a ticket. The upload pipeline has no tenant purpose or work-order entity, and `POST /work-orders/{id}/evidence` accepts only the assignee or staff. The form says so and asks for a written description.
- **Invitation preview.** There is no preview endpoint. The accept page reads the invitation by its token hash with a read-only server helper (`lib/tenant/server/invitations.ts`), because the party row is not visible to the invitee until it is accepted.
- **Invoices list.** There is no tenant invoice endpoint. The balances page reads invoice rows where the tenant is the invoiced customer on their own lease. Row-level security allows this read, and it mirrors the receipts service.
- **Parties.** The tenant sees only their own party record. The landlord's name and co-tenants are not exposed to tenants.
- **Ticket history.** Work orders record only the reported, approved, completed and verified times, plus the time of the last change. Intermediate steps are shown without dates.
- **Appointments** are read-only here. Rescheduling goes through the booking confirmation or the property manager.
