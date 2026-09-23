# Collaboration: assignments, tasks, notes and conversations

Server modules under `apps/web/src/server/{properties,assignments,tasks,notes,conversations}`; routes under `apps/web/src/app/api/v1/…`; contracts in `packages/contracts/src/{properties,collaboration}.ts`; OpenAPI in `apps/web/src/lib/api/registry/collaboration.ts`.

Every service takes the resolved `RequestIdentity`, runs inside `withActor(getDb(), identity.ctx, …)` so row-level security applies to every read, authorises with `@simplexd/domain/authz`, writes an audit event in the same transaction, and appends outbox events (`assignment.proposed`, `assignment.responded`, `task.assigned`, `task.completed`, `message.posted`) that carry ids and recipient user ids only, never message text.

## Assignment lifecycle

```
proposed ──accept (assignee)──▶ accepted ──activate (staff)──▶ active ──complete (staff|assignee)──▶ completed
   │                                │                              │
   └──decline (assignee)──▶ declined└──────── revoke (staff, reason) ────────▶ revoked
```

- Staff propose with `service_requests.assign` or `projects.manage`; project managers only on requests/projects they are attached to. The assignee must hold an active staff role or a `partner_profiles` row. One open assignment per (assignee, role, entity).
- Only `accepted` and `active` assignments grant access to the linked service request or project — in the application policy (`loadAssignmentContext`) and in the database (`app.can_access_service_request` / `app.can_access_project`). Revoking therefore removes the partner's access the moment the transaction commits (covered by `assignments.int.test.ts`).
- Customers see accepted/active/completed assignments on their entities (who is working for them), never the staffing churn. Partners see only their own rows (`GET /api/v1/assignments/mine`).
- `loadAssignmentContext(tx, { userId, projectId?, serviceRequestId?, statuses? })` in `apps/web/src/server/assignments/access.ts` returns `{ assigneeUserIds, assignedProjectIds, assignedServiceRequestIds }` for building `ResourceRef`s in other modules. `resolveEntity` / `classifyViewer` in the same file classify a caller as `staff`, `assignee` or `customer` for any service request, project, property, lead, site visit, report or defect.

## Task visibility

Every task carries an explicit `visibility`, enforced in SQL on every list and re-checked on every read:

| visibility | staff | customer organisation | assigned partner                             |
| ---------- | ----- | --------------------- | -------------------------------------------- |
| `internal` | yes   | never                 | never (cannot even be assigned to a partner) |
| `customer` | yes   | yes                   | no                                           |
| `partner`  | yes   | no                    | yes                                          |
| `all`      | yes   | yes                   | yes                                          |

Staff create tasks; `requiresCustomerAction` tasks must be `customer` or `all` and feed `GET /api/v1/tasks/mine` for customers ("awaiting your approval" on the portal home). Completing: the assignee, staff who manage the parent, or — for customer-action tasks — members who can raise requests or approvers who accept milestones (`org.requests.create` / `org.milestones.accept`; advisers only read). Block/unblock: assignee or staff, reason kept in the audit trail (the table has no reason column). Cancel: staff with a reason.

## Note visibility

Notes are append-only (create and list only; a correction is a new note). `visibility` is required and authorisation derives from the parent entity: staff may write any visibility they can read; customers write `customer`/`all` (`org.comment`); partners write `partner`/`all` on entities they are assigned to. Readers: staff see everything; customers `customer`/`all`; partners `partner`/`all` plus their own. `internal` never leaves the staff (`notes.int.test.ts`).

## Conversations

- Access is by participation. Non-participants receive `not_found` even with a valid id; staff who are not participants can observe with `messages.read_all` but cannot post.
- Every participant must already have access to the linked entity or organisation: organisation members, staff, or partners with an accepted/active assignment. `internal` conversations are staff-only.
- Posting needs participation plus `org.messages.send` (members), `tenant.messages.send` (tenant members, participant-based until lease resolution exists), a partner account, or a staff role. `internalOnly` messages are staff-only in the application and in the `messages` policy.
- Attachments are `file_objects` ids the sender can see under their own context; quarantined files are refused (`file_quarantined`), rejected/deleted ones with `file_rejected`. Storage keys are never returned.
- Add/remove participants and close: staff or the creator; anyone may leave. `POST …/read` stores `lastReadAt`; list responses carry `unreadCount`.
- **Partner-started conversations** (`POST /api/v1/conversations/partner`, `apps/web/src/server/conversations/partner.ts`): a partner account opens a `partner` thread about a project or service request they hold an accepted/active assignment on, a tender they were invited to, or an RFQ/purchase order naming them (the commercial kinds need their expansion flag). The partner never names participants: the server adds the staff attached to the record (the project's `pmUserId` / the request's `assignedPmUserId`, staff assigned as `project_manager`, `coordinator` or `support`, the issuer of a tender, RFQ or order) and falls back to the active operations managers (at most ten); customers are never added, though staff may add them later. Staff lookups run elevated after the partner's own relationship was proven under their context. The first message is posted with the thread and `conversation.partner_started` tells the staff side. To support this, `resolveEntity` also understands `tender` (assignees: invited partners), `purchase_order` (the named supplier once issued) and `rfq` (responding suppliers).

## Properties

Private assets separate from listings. Customers manage with `org.properties.manage`, staff with `customers.manage`/`projects.manage`; reads need `org.read`, `customers.read` or `projects.read_all`. Land areas keep the declared value and unit verbatim next to a derived m²; a Nigerian "plot" is never converted. Owner authority documents must be same-organisation files that are not quarantined; verification and rejection need `rentals.manage` (a listings/rentals moderation duty held by operations, finance and super administrators), and a verified authority reads as `expired` past `expiresAt`.

## Known database policy gaps (packages/db, not owned here)

- `properties` uses `WITH CHECK app.can_access_property(id)`, which looks the new row up before it exists: no actor (customer, staff or bypass) can INSERT a property through the runtime role. `createProperty` is correct but blocked until the policy is split (read `can_access_property(id)`, write `app.org_match(organization_id)`). The create test self-skips until then.
- The `tasks` and `notes` policies have no assignment clause, so partner-visible rows on an assigned entity are read under a briefly elevated context _after_ the assignment has been proven under the partner's own context, with the visibility filter applied in SQL. Adding an assignment clause to both policies would let that elevation go.
- `conversations` cannot be inserted by a non-staff creator (`can_access_conversation(id)` needs a participant row first); creation elevates after the creator's entity access is proven.
