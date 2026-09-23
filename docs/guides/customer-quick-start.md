# Customer quick start (portal)

This guide explains what a customer does in the portal at `/portal` and what SimplexD staff do on
the other side, as the product is built today. The staff side is described in
[admin-quick-start.md](./admin-quick-start.md).

Your organisation (a family, company or individual owner) is the unit of access. Owners can invite
members, advisers and approvers under _Settings_; what each person may approve or pay depends on
their role, and the portal explains when something needs a different role.

## 1. Request a service

1. _Requests → New request_ (`/portal/requests/new`): choose the service, describe what you need,
   optionally pick a market, a budget, a preferred timeline or one of your saved location
   scenarios, and answer the service's intake questions.
2. The request starts as an _inquiry_. SimplexD triages it, assigns a project manager and works to
   an SLA; you see status changes, customer-visible notes and the timeline on the request page.
3. You can pause, resume or cancel a request from its page (a reason is recorded).

## 2. Accept a quotation

When staff issue a quote you get a notification and it appears under the request and in
_Approvals_. Open it (`/portal/quotes/{id}`) to see the version, lines, tax, deposit and validity,
then accept or reject it. A new version supersedes the old one; only the issued version can be
accepted. Accepting creates the deposit or service invoice when payment is required.

## 3. Pay an invoice

Open the invoice from _Invoices_ (`/portal/invoices/{id}`):

- **Card or bank checkout** opens the payment provider's hosted page; card details never reach
  SimplexD. Returning from checkout is not proof of payment: the portal shows the verified result
  once the server has checked it with the provider (it may say pending or uncertain for a while).
- **Bank transfer:** pay into the account on the invoice, then _Pay by bank transfer_ to declare
  the amount, date and bank reference and optionally upload the slip. Finance confirms it against
  the bank statement; only then is it allocated and a receipt issued. A declaration can be
  rejected with a note.

Receipts, credit notes and refunds appear on the invoice. Refunds are approved by two different
finance staff and are marked settled only when the provider confirms them.

## 4. Follow the work

- **Projects** (`/portal/projects/{id}`): schedule, budget, milestones, reports, evidence that
  staff approved for you, defects and decisions.
- **Approvals** (`/portal/approvals`): quotes, change orders, budget versions and milestones
  waiting on your organisation. A change order changes the approved budget only after every
  approval it needs; accepting a milestone is separate from the inspector's progress estimate and
  from finance's payment authorisation.
- **Reports** (`/portal/reports`): you see a report only after a named reviewer (not the author)
  approved it and staff released it. Each released version stays frozen. _Export (print / save as
  PDF)_ opens a print-ready copy with the version, release date, reviewer, scope and limitations
  and the evidence it references (file names and checksums); use your browser's Print → Save as
  PDF to keep a PDF.
- **Due diligence / Inspection tab** on a request (`/portal/requests/{id}?tab=workspace`): the
  title and document checklist, survey references, findings, red flags with their severity and the
  team's queries. Answer a query or upload a requested document from the _Waiting on you_ list;
  your answer is recorded with your name and the team is notified. Internal staff notes never
  appear here. Released decision memoranda and inspection reports are listed with an export
  button; for a virtual inspection the live meeting link appears while the conference is ready.
- **Documents** (`/portal/documents`): files you uploaded and files released to you. Downloads use
  short-lived links, and files that failed the malware scan are never offered.

## 5. Appointments and messages

- _Appointments → Book_ (`/portal/appointments/new`) shows live slots in your time zone and the
  business zone. A slot is held for a few minutes while you confirm; you can reschedule or cancel
  from the appointment page and download a calendar file. When Google Meet is available the link
  appears once it is ready; if it fails, staff see it and retry.
- _Messages_ (`/portal/messages`) holds conversations with your team. Staff internal notes are
  never shown to you.

## 6. Properties you own or let

- _Properties_ lists your properties, units, owner-authority documents and linked projects.
- If SimplexD manages lettings for you, _Properties → Statements_ shows owner statements after
  finance has reconciled them: rent and service charges collected, management fees, maintenance
  recovered and the net payable. Rent collected on your behalf is held for you; payouts need two
  separate finance approvals.
- Maintenance you raise (or your tenants raise) is triaged by staff; you approve or reject quoted
  costs and can verify completed work.

## 7. Settings and notifications

Profile and time zone, organisation members and invitations, notification preferences (channels,
digest, quiet hours), marketing consent and account deletion requests are under _Settings_.
_Notifications_ lists everything sent to you in the app.
