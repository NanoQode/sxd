import 'server-only';
import { and, asc, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import {
  ApiError,
  type EngagementItemCreate,
  type EngagementItemDto,
  type EngagementItemEvidence,
  type EngagementItemFileDto,
  type EngagementItemListQuery,
  type EngagementItemResponseCreate,
  type EngagementItemResponseDto,
  type EngagementItemTransition,
  type EngagementItemUpdate,
  type MyEngagementItemsQuery,
  type Page,
} from '@simplexd/contracts';
import {
  appendOutbox,
  getDb,
  schema,
  withActor,
  type ActorContext,
  type Transaction,
} from '@simplexd/db';
import { AuthorizationError, authorizeOrg, authorizePartner } from '@simplexd/domain/authz';
import {
  OPEN_ITEM_STATUSES,
  availableItemTransitions,
  customerCanSee,
  customerMayAttach,
  customerMayRespond,
  evaluateItemTransition,
  kindRule,
  partnerCanSee,
  statusAfterCustomerInput,
  validateItemFields,
  type EngagementItemKind,
  type ItemActor,
  type ItemVisibility,
} from '@simplexd/domain/engagements';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { decideFileAccess, elevated, freshMemberships } from '@/server/files/access';
import { isSensitivePurpose } from '@/server/files/shared';
import type { AccessCheck } from '@/server/projects/access';
import {
  assertVersion,
  ctxFor,
  decodeCursor,
  iso,
  notFound,
  pageSlice,
  userIdOf,
  versionConflict,
  type ServiceOptions,
} from '@/server/projects/shared';
import {
  REQUEST_MANAGE_CHECKS,
  REQUEST_READ_CHECKS,
  allowsRequest,
  isRequestCustomer,
  loadServiceRequestAccess,
  requireServiceRequest,
  type ServiceRequestAccess,
} from './access';

/**
 * Engagement items: the generic record behind due-diligence checklists,
 * survey references, site findings, queries and red flags, and behind the
 * purchase-representation closing checklist, conditions, handover documents
 * and lease milestones. One service for every kind; per-kind behaviour comes
 * from `ENGAGEMENT_ITEM_KIND_RULES` in `@simplexd/domain/engagements`.
 *
 * Public functions (all take the request identity and enforce access):
 * - `listEngagementItems(identity, serviceRequestId, query)` — items the caller may see;
 * - `listMyEngagementItems(identity, query)` — items assigned to the caller;
 * - `getEngagementItem(identity, id)`;
 * - `createEngagementItem(identity, serviceRequestId, input)` — staff who manage the request;
 * - `updateEngagementItem(identity, id, input)` — managers (all fields) or the assignee
 *   (detail, reference, severity);
 * - `transitionEngagementItem(identity, id, input)` — status with reasons (see the domain table);
 * - `attachEngagementItemEvidence(identity, id, input)` — managers, the assignee (their own
 *   uploads) and customers (documents against checklist items that accept them);
 * - `respondToEngagementItem(identity, id, input)` — customer answers to queries, and replies
 *   from staff or the assignee.
 *
 * Who sees what (row-level security from migration 0007 is the second net):
 * - staff who manage or read the request see every item;
 * - the assignee sees their item (partners only while their assignment on the
 *   request is accepted or active);
 * - customers see items whose visibility is `customer` or `all`;
 * - partners assigned to the request see items marked `partner` or `all`, read-only;
 * - evidence lists only the files the caller may open under the file policy.
 *
 * Every mutation is versioned (`expectedVersion`), audited and, where
 * someone must act, announced through an outbox event.
 */

type ItemRow = typeof schema.engagementItems.$inferSelect;
type FileRow = typeof schema.fileObjects.$inferSelect;

export type ItemViewer = 'manager' | 'staff_reader' | 'assignee' | 'customer' | 'partner_reader';

const CLOSED_REQUEST_STATUSES = ['completed', 'cancelled', 'rejected'];
const ATTACHABLE_PURPOSES = ['org_document', 'evidence'];
const UNUSABLE_FILE_STATUSES = ['pending_upload', 'infected', 'scan_failed', 'rejected', 'deleted'];

/* ---------------------------------------------------------------------- */
/* Viewer classification and capabilities                                  */
/* ---------------------------------------------------------------------- */

function isStaff(identity: RequestIdentity): boolean {
  return identity.actor.staffRoles.length > 0;
}

/** Can the caller manage this request's items (optionally for one kind)? */
export function canManageItems(
  identity: RequestIdentity,
  access: ServiceRequestAccess,
  kind?: EngagementItemKind,
): boolean {
  if (!isStaff(identity)) return false;
  const checks: AccessCheck[] = [...REQUEST_MANAGE_CHECKS];
  if (kind) {
    for (const p of kindRule(kind).extraCreatePermissions)
      checks.push({ staff: p as NonNullable<AccessCheck['staff']> });
  }
  return allowsRequest(identity, access, checks);
}

/**
 * How the caller relates to one item, or null when the item must stay
 * invisible to them (callers answer "not found").
 */
export function classifyItemViewer(
  identity: RequestIdentity,
  access: ServiceRequestAccess,
  item: Pick<ItemRow, 'assigneeUserId' | 'visibility' | 'kind'>,
): ItemViewer | null {
  const userId = identity.session?.user.id;
  if (!userId) return null;
  const staff = isStaff(identity);
  if (staff && canManageItems(identity, access, item.kind)) return 'manager';
  if (item.assigneeUserId === userId) {
    // Partners keep access only while their assignment on the request is accepted/active.
    if (staff || access.partnerAssigneeIds.includes(userId)) return 'assignee';
  }
  if (staff && allowsRequest(identity, access, REQUEST_READ_CHECKS)) return 'staff_reader';
  const visibility = item.visibility as ItemVisibility;
  if (
    isRequestCustomer(identity, access) &&
    customerCanSee(visibility) &&
    allowsRequest(identity, access, [{ org: 'org.read' }])
  )
    return 'customer';
  if (
    !staff &&
    identity.actor.isPartner &&
    access.partnerAssigneeIds.includes(userId) &&
    partnerCanSee(visibility) &&
    allowsRequest(identity, access, [{ partner: 'partner.assignments.view' }])
  )
    return 'partner_reader';
  return null;
}

function requestOpen(access: ServiceRequestAccess): boolean {
  return !CLOSED_REQUEST_STATUSES.includes(access.sr.status);
}

function assertRequestOpen(access: ServiceRequestAccess): void {
  if (!requestOpen(access))
    throw new ApiError(
      'invalid_transition',
      `the request is ${access.sr.status}; its engagement records are read-only`,
    );
}

function orgAllows(
  identity: RequestIdentity,
  access: ServiceRequestAccess,
  permission: 'org.documents.upload' | 'org.comment',
): boolean {
  return authorizeOrg(identity.actor, permission, {
    type: 'service_request',
    id: access.sr.id,
    organizationId: access.sr.organizationId,
  }).allowed;
}

function partnerMayUpload(identity: RequestIdentity, access: ServiceRequestAccess): boolean {
  if (isStaff(identity)) return true;
  return authorizePartner(identity.actor, 'partner.evidence.upload', {
    type: 'service_request',
    id: access.sr.id,
    assigneeUserIds: access.partnerAssigneeIds,
  }).allowed;
}

const MANAGER_FIELDS = [
  'title',
  'detail',
  'reference',
  'severity',
  'visibility',
  'assigneeUserId',
  'dueAt',
  'sortOrder',
];
const ASSIGNEE_FIELDS = ['detail', 'reference', 'severity'];

function capabilitiesFor(
  identity: RequestIdentity,
  access: ServiceRequestAccess,
  row: ItemRow,
  viewer: ItemViewer,
): EngagementItemDto['can'] {
  const none = { editableFields: [], transitions: [], attachEvidence: false, respond: false };
  if (!requestOpen(access)) return none;
  const open = OPEN_ITEM_STATUSES.includes(row.status);
  switch (viewer) {
    case 'manager':
      return {
        editableFields: row.status === 'cancelled' ? [] : MANAGER_FIELDS,
        transitions: availableItemTransitions(row.status, 'manager'),
        attachEvidence: row.status !== 'cancelled',
        respond: open,
      };
    case 'assignee':
      return {
        editableFields: open ? ASSIGNEE_FIELDS : [],
        transitions: availableItemTransitions(row.status, 'assignee'),
        attachEvidence: open && partnerMayUpload(identity, access),
        respond: open,
      };
    case 'customer':
      return {
        editableFields: [],
        transitions: [],
        attachEvidence:
          customerMayAttach(row).ok && orgAllows(identity, access, 'org.documents.upload'),
        respond: customerMayRespond(row).ok && orgAllows(identity, access, 'org.comment'),
      };
    default:
      return none;
  }
}

/* ---------------------------------------------------------------------- */
/* DTO assembly                                                            */
/* ---------------------------------------------------------------------- */

async function nameMap(
  tx: Transaction,
  ids: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((v): v is string => Boolean(v)))];
  if (unique.length === 0) return new Map();
  const rows = await tx
    .select({ id: schema.user.id, name: schema.user.name })
    .from(schema.user)
    .where(inArray(schema.user.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * Files among `fileIds` the caller may open, decided by the same policy as
 * downloads (fresh memberships, owner, grants, staff permissions). The read
 * is elevated because the decision itself is the filter.
 */
async function visibleFiles(
  tx: Transaction,
  identity: RequestIdentity,
  ctx: ActorContext,
  fileIds: string[],
): Promise<Map<string, FileRow>> {
  const unique = [...new Set(fileIds)];
  const out = new Map<string, FileRow>();
  if (unique.length === 0) return out;
  const userId = userIdOf(identity);
  return elevated(tx, ctx, async () => {
    const files = await tx
      .select()
      .from(schema.fileObjects)
      .where(and(inArray(schema.fileObjects.id, unique), isNull(schema.fileObjects.deletedAt)));
    const memberships = await freshMemberships(tx, userId);
    const orgIds = new Set(memberships.map((m) => m.organizationId));
    const grants =
      files.length === 0
        ? []
        : await tx
            .select()
            .from(schema.fileAccessGrants)
            .where(
              and(
                inArray(
                  schema.fileAccessGrants.fileId,
                  files.map((f) => f.id),
                ),
                isNull(schema.fileAccessGrants.revokedAt),
              ),
            );
    const now = Date.now();
    for (const file of files) {
      const applicable = grants.filter(
        (g) =>
          g.fileId === file.id &&
          (!g.expiresAt || g.expiresAt.getTime() > now) &&
          ((g.userId !== null && g.userId === userId) ||
            (g.organizationId !== null && orgIds.has(g.organizationId))),
      );
      if (decideFileAccess(identity, { file, grants: applicable, memberships }, 'view').allowed)
        out.set(file.id, file);
    }
    return out;
  });
}

interface ResponseRow {
  id: string;
  entityId: string;
  body: string;
  visibility: ItemVisibility;
  authorUserId: string;
  createdAt: Date;
}

/**
 * Responses (customer answers and replies) are rows in `notes` with
 * entity_type `engagement_item`. The notes policy has no assignment clause,
 * so the read is elevated after the item itself was authorised; each viewer
 * then gets only the responses their visibility allows.
 */
async function loadResponses(
  tx: Transaction,
  ctx: ActorContext,
  itemIds: string[],
): Promise<{ rows: ResponseRow[]; roles: Map<string, 'customer' | 'staff' | 'partner'> }> {
  if (itemIds.length === 0) return { rows: [], roles: new Map() };
  return elevated(tx, ctx, async () => {
    const rows = await tx
      .select({
        id: schema.notes.id,
        entityId: schema.notes.entityId,
        body: schema.notes.body,
        visibility: schema.notes.visibility,
        authorUserId: schema.notes.authorUserId,
        createdAt: schema.notes.createdAt,
        organizationId: schema.notes.organizationId,
      })
      .from(schema.notes)
      .where(
        and(eq(schema.notes.entityType, 'engagement_item'), inArray(schema.notes.entityId, itemIds)),
      )
      .orderBy(asc(schema.notes.createdAt), asc(schema.notes.id));
    const authors = [...new Set(rows.map((r) => r.authorUserId))];
    const staffRows =
      authors.length === 0
        ? []
        : await tx
            .select({ userId: schema.staffRoles.userId })
            .from(schema.staffRoles)
            .where(
              and(inArray(schema.staffRoles.userId, authors), isNull(schema.staffRoles.revokedAt)),
            );
    const staffIds = new Set(staffRows.map((r) => r.userId));
    const memberRows =
      authors.length === 0
        ? []
        : await tx
            .select({ userId: schema.member.userId, organizationId: schema.member.organizationId })
            .from(schema.member)
            .where(inArray(schema.member.userId, authors));
    const roles = new Map<string, 'customer' | 'staff' | 'partner'>();
    for (const r of rows) {
      const member = memberRows.some(
        (m) => m.userId === r.authorUserId && m.organizationId === r.organizationId,
      );
      roles.set(
        r.authorUserId,
        staffIds.has(r.authorUserId) ? 'staff' : member ? 'customer' : 'partner',
      );
    }
    return {
      rows: rows.map((r) => ({ ...r, visibility: r.visibility as ItemVisibility })),
      roles,
    };
  });
}

function responseVisibleTo(viewer: ItemViewer, visibility: ItemVisibility): boolean {
  switch (viewer) {
    case 'manager':
    case 'staff_reader':
    case 'assignee':
      return true;
    case 'customer':
      return customerCanSee(visibility);
    case 'partner_reader':
      return partnerCanSee(visibility);
  }
}

export interface ItemEntry {
  row: ItemRow;
  viewer: ItemViewer;
  access: ServiceRequestAccess;
}

export async function buildItemDtos(
  tx: Transaction,
  identity: RequestIdentity,
  ctx: ActorContext,
  entries: ItemEntry[],
): Promise<EngagementItemDto[]> {
  if (entries.length === 0) return [];
  const files = await visibleFiles(
    tx,
    identity,
    ctx,
    entries.flatMap((e) => e.row.fileIds ?? []),
  );
  const responses = await loadResponses(
    tx,
    ctx,
    entries.map((e) => e.row.id),
  );
  const names = await nameMap(tx, [
    ...entries.flatMap((e) => [e.row.assigneeUserId, e.row.resolvedBy]),
    ...[...files.values()].map((f) => f.ownerUserId),
    ...responses.rows.map((r) => r.authorUserId),
  ]);
  return entries.map(({ row, viewer, access }) => {
    const evidence: EngagementItemFileDto[] = (row.fileIds ?? []).flatMap((fileId) => {
      const f = files.get(fileId);
      if (!f) return [];
      return [
        {
          fileId: f.id,
          originalName: f.originalName,
          status: f.status,
          sizeBytes: f.sizeBytes ?? null,
          checksumSha256: f.checksumSha256 ?? null,
          uploadedByUserId: f.ownerUserId,
          uploadedByName: f.ownerUserId ? (names.get(f.ownerUserId) ?? null) : null,
          receivedAt: f.createdAt.toISOString(),
        },
      ];
    });
    const itemResponses: EngagementItemResponseDto[] = responses.rows
      .filter((r) => r.entityId === row.id && responseVisibleTo(viewer, r.visibility))
      .map((r) => ({
        id: r.id,
        body: r.body,
        authorUserId: r.authorUserId,
        authorName: names.get(r.authorUserId) ?? null,
        authorRole: responses.roles.get(r.authorUserId) ?? 'partner',
        createdAt: r.createdAt.toISOString(),
      }));
    return {
      id: row.id,
      organizationId: row.organizationId,
      serviceRequestId: row.serviceRequestId,
      serviceRequestReference: access.sr.reference,
      serviceRequestTitle: access.sr.title,
      kind: row.kind,
      kindLabel: kindRule(row.kind).label,
      title: row.title,
      detail: row.detail,
      reference: row.reference,
      status: row.status,
      severity: row.severity,
      visibility: row.visibility,
      assigneeUserId: row.assigneeUserId,
      assigneeName: row.assigneeUserId ? (names.get(row.assigneeUserId) ?? null) : null,
      dueAt: iso(row.dueAt),
      resolvedAt: iso(row.resolvedAt),
      resolvedByName: row.resolvedBy ? (names.get(row.resolvedBy) ?? null) : null,
      resolutionNote: row.resolutionNote,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      sortOrder: row.sortOrder,
      evidence,
      responses: itemResponses,
      can: capabilitiesFor(identity, access, row, viewer),
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

/* ---------------------------------------------------------------------- */
/* Loading                                                                 */
/* ---------------------------------------------------------------------- */

interface LoadedItem {
  row: ItemRow;
  access: ServiceRequestAccess;
  viewer: ItemViewer;
}

/** Loads the item and its request under row-level security, then classifies the caller. */
async function loadItem(tx: Transaction, identity: RequestIdentity, id: string): Promise<LoadedItem> {
  userIdOf(identity);
  const [row] = await tx
    .select()
    .from(schema.engagementItems)
    .where(eq(schema.engagementItems.id, id));
  if (!row) throw notFound('item');
  const access = await loadServiceRequestAccess(tx, row.serviceRequestId);
  if (!access) throw notFound('item');
  const viewer = classifyItemViewer(identity, access, row);
  if (!viewer) throw notFound('item');
  return { row, access, viewer };
}

function forbidden(message: string): AuthorizationError {
  return new AuthorizationError({ allowed: false, code: 'no_permission', reason: message });
}

/**
 * A new assignee must be able to reach the request: staff (any active staff
 * role), or a partner holding an accepted/active assignment on it.
 */
async function assertAssignee(
  tx: Transaction,
  ctx: ActorContext,
  access: ServiceRequestAccess,
  userId: string,
): Promise<'staff' | 'partner'> {
  const [u] = await tx
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.id, userId));
  if (!u)
    throw new ApiError('validation_failed', 'assignee does not exist', {
      details: [{ path: 'assigneeUserId', message: 'unknown user' }],
    });
  const staff = await elevated(tx, ctx, () =>
    tx
      .select({ id: schema.staffRoles.id })
      .from(schema.staffRoles)
      .where(and(eq(schema.staffRoles.userId, userId), isNull(schema.staffRoles.revokedAt)))
      .limit(1),
  );
  if (staff.length > 0) return 'staff';
  if (access.partnerAssigneeIds.includes(userId)) return 'partner';
  throw new ApiError(
    'validation_failed',
    'assign items to staff, or to a partner whose assignment on this request is accepted or active',
    { details: [{ path: 'assigneeUserId', message: 'no access to this request' }] },
  );
}

/** Gives the item's assignee view access to evidence they do not own (idempotent). */
async function grantToAssignee(
  tx: Transaction,
  ctx: ActorContext,
  assigneeUserId: string,
  fileIds: string[],
  grantedBy: string,
): Promise<void> {
  if (fileIds.length === 0) return;
  await elevated(tx, ctx, async () => {
    const files = await tx
      .select({ id: schema.fileObjects.id, ownerUserId: schema.fileObjects.ownerUserId })
      .from(schema.fileObjects)
      .where(inArray(schema.fileObjects.id, fileIds));
    const existing = await tx
      .select({ fileId: schema.fileAccessGrants.fileId })
      .from(schema.fileAccessGrants)
      .where(
        and(
          inArray(schema.fileAccessGrants.fileId, fileIds),
          eq(schema.fileAccessGrants.userId, assigneeUserId),
          isNull(schema.fileAccessGrants.revokedAt),
        ),
      );
    const have = new Set(existing.map((g) => g.fileId));
    const toGrant = files.filter((f) => f.ownerUserId !== assigneeUserId && !have.has(f.id));
    if (toGrant.length > 0) {
      await tx.insert(schema.fileAccessGrants).values(
        toGrant.map((f) => ({
          fileId: f.id,
          userId: assigneeUserId,
          level: 'view' as const,
          grantedBy,
        })),
      );
    }
  });
}

interface OutboxContext {
  identity: RequestIdentity;
  actorId: string;
  options: ServiceOptions;
}

async function announceAssignment(
  tx: Transaction,
  { actorId, options }: OutboxContext,
  row: ItemRow,
  access: ServiceRequestAccess,
  assigneeKind: 'staff' | 'partner',
): Promise<void> {
  if (!row.assigneeUserId || row.assigneeUserId === actorId) return;
  await appendOutbox(tx, {
    eventType: 'engagement_item.assigned',
    aggregateType: 'engagement_item',
    aggregateId: row.id,
    organizationId: row.organizationId,
    actorUserId: actorId,
    payload: {
      itemId: row.id,
      serviceRequestId: row.serviceRequestId,
      reference: access.sr.reference,
      kind: row.kind,
      kindLabel: kindRule(row.kind).label,
      recipientUserIds: [row.assigneeUserId],
      linkPath:
        assigneeKind === 'partner'
          ? `/partner/items?serviceRequestId=${row.serviceRequestId}`
          : `/admin/service-requests/${row.serviceRequestId}#engagement-records`,
    },
    correlationId: options.correlationId ?? null,
  });
}

async function announceToCustomer(
  tx: Transaction,
  { actorId, options }: OutboxContext,
  row: ItemRow,
  access: ServiceRequestAccess,
  reason: 'created' | 'reply',
): Promise<void> {
  await appendOutbox(tx, {
    eventType: 'engagement_item.customer_action',
    aggregateType: 'engagement_item',
    aggregateId: row.id,
    organizationId: row.organizationId,
    actorUserId: actorId,
    payload: {
      itemId: row.id,
      serviceRequestId: row.serviceRequestId,
      reference: access.sr.reference,
      kind: row.kind,
      kindLabel: kindRule(row.kind).label,
      severity: row.severity,
      reason,
      linkPath: `/portal/requests/${row.serviceRequestId}?tab=workspace`,
    },
    correlationId: options.correlationId ?? null,
  });
}

/** Staff on the request who hear about customer and assignee input. */
function staffRecipients(row: ItemRow, access: ServiceRequestAccess, actorId: string): string[] {
  return [
    ...new Set(
      [row.assigneeUserId, access.sr.assignedPmUserId, row.createdBy].filter(
        (v): v is string => Boolean(v) && v !== actorId,
      ),
    ),
  ];
}

/* ---------------------------------------------------------------------- */
/* Queries                                                                 */
/* ---------------------------------------------------------------------- */

export async function listEngagementItems(
  identity: RequestIdentity,
  serviceRequestId: string,
  query: Partial<EngagementItemListQuery> = {},
): Promise<Page<EngagementItemDto>> {
  userIdOf(identity);
  const ctx = ctxFor(identity);
  return withActor(getDb(), ctx, async (tx) => {
    const access = await requireServiceRequest(tx, identity, serviceRequestId, REQUEST_READ_CHECKS);
    const entries = await visibleItemsOf(tx, identity, access, query);
    const limit = query.limit ?? 200;
    const cursor = decodeCursor(query.cursor);
    const afterCursor = cursor
      ? entries.filter(
          (e) =>
            e.row.createdAt.getTime() < cursor.createdAt.getTime() ||
            (e.row.createdAt.getTime() === cursor.createdAt.getTime() && e.row.id < cursor.id),
        )
      : entries;
    const page = pageSlice(
      afterCursor.map((e) => ({ ...e, createdAt: e.row.createdAt, id: e.row.id })),
      limit,
    );
    return {
      items: await buildItemDtos(tx, identity, ctx, page.items),
      nextCursor: page.nextCursor,
    };
  });
}

/** Items of a request visible to the caller, newest first (used by lists and the workspace). */
export async function visibleItemsOf(
  tx: Transaction,
  identity: RequestIdentity,
  access: ServiceRequestAccess,
  query: { kind?: EngagementItemKind; status?: ItemRow['status'] } = {},
): Promise<ItemEntry[]> {
  const rows = await tx
    .select()
    .from(schema.engagementItems)
    .where(
      and(
        eq(schema.engagementItems.serviceRequestId, access.sr.id),
        query.kind ? eq(schema.engagementItems.kind, query.kind) : undefined,
        query.status ? eq(schema.engagementItems.status, query.status) : undefined,
      ),
    )
    .orderBy(desc(schema.engagementItems.createdAt), desc(schema.engagementItems.id));
  return rows.flatMap((row) => {
    const viewer = classifyItemViewer(identity, access, row);
    return viewer ? [{ row, viewer, access }] : [];
  });
}

export async function getEngagementItem(
  identity: RequestIdentity,
  id: string,
): Promise<EngagementItemDto> {
  const ctx = ctxFor(identity);
  return withActor(getDb(), ctx, async (tx) => {
    const loaded = await loadItem(tx, identity, id);
    const [dto] = await buildItemDtos(tx, identity, ctx, [loaded]);
    return dto!;
  });
}

/** Items assigned to the caller across requests (partner workspace, staff "my items"). */
export async function listMyEngagementItems(
  identity: RequestIdentity,
  query: Partial<MyEngagementItemsQuery> = {},
): Promise<Page<EngagementItemDto>> {
  const userId = userIdOf(identity);
  const partner = !isStaff(identity);
  if (partner) {
    const decision = authorizePartner(identity.actor, 'partner.assignments.view', {
      type: 'engagement_item',
      assigneeUserIds: [userId],
    });
    if (!decision.allowed) throw new AuthorizationError(decision);
  }
  const ctx = ctxFor(identity);
  const limit = query.limit ?? 50;
  const openOnly = query.openOnly ?? true;
  return withActor(getDb(), ctx, async (tx) => {
    const cursor = decodeCursor(query.cursor);
    const rows = await tx
      .select()
      .from(schema.engagementItems)
      .where(
        and(
          eq(schema.engagementItems.assigneeUserId, userId),
          query.serviceRequestId
            ? eq(schema.engagementItems.serviceRequestId, query.serviceRequestId)
            : undefined,
          query.kind ? eq(schema.engagementItems.kind, query.kind) : undefined,
          query.status
            ? eq(schema.engagementItems.status, query.status)
            : openOnly
              ? inArray(schema.engagementItems.status, [...OPEN_ITEM_STATUSES])
              : undefined,
          cursor
            ? or(
                lt(schema.engagementItems.createdAt, cursor.createdAt),
                and(
                  eq(schema.engagementItems.createdAt, cursor.createdAt),
                  lt(schema.engagementItems.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.engagementItems.createdAt), desc(schema.engagementItems.id))
      .limit(500);
    const accessBySr = new Map<string, ServiceRequestAccess | null>();
    const entries: Array<ItemEntry & { createdAt: Date; id: string }> = [];
    for (const row of rows) {
      if (!accessBySr.has(row.serviceRequestId))
        accessBySr.set(row.serviceRequestId, await loadServiceRequestAccess(tx, row.serviceRequestId));
      const access = accessBySr.get(row.serviceRequestId);
      if (!access) continue;
      const viewer = classifyItemViewer(identity, access, row);
      // Revoked partners keep the rows (row-level security lets assignees read
      // them) but not the access; the classification drops them here.
      if (viewer !== 'assignee' && viewer !== 'manager') continue;
      entries.push({ row, viewer, access, createdAt: row.createdAt, id: row.id });
      if (entries.length > limit) break;
    }
    const page = pageSlice(entries, limit);
    return {
      items: await buildItemDtos(tx, identity, ctx, page.items),
      nextCursor: page.nextCursor,
    };
  });
}

/* ---------------------------------------------------------------------- */
/* Mutations                                                               */
/* ---------------------------------------------------------------------- */

export async function createEngagementItem(
  identity: RequestIdentity,
  serviceRequestId: string,
  input: EngagementItemCreate,
  options: ServiceOptions = {},
): Promise<EngagementItemDto> {
  const actorId = userIdOf(identity);
  const ctx = ctxFor(identity, options);
  if (!isStaff(identity))
    throw forbidden('engagement records are created by staff who manage the request');
  const rule = kindRule(input.kind);
  return withActor(getDb(), ctx, async (tx) => {
    const access = await requireServiceRequest(tx, identity, serviceRequestId, REQUEST_READ_CHECKS);
    if (!canManageItems(identity, access, input.kind))
      throw forbidden(`you do not manage this request's ${rule.pluralLabel.toLowerCase()}`);
    assertRequestOpen(access);
    const visibility = (input.visibility ?? rule.defaultVisibility) as ItemVisibility;
    const problems = validateItemFields({
      kind: input.kind,
      title: input.title,
      severity: input.severity ?? null,
      visibility,
    });
    if (problems.length > 0)
      throw new ApiError('validation_failed', problems[0]!.message, { details: problems });
    const assigneeKind = input.assigneeUserId
      ? await assertAssignee(tx, ctx, access, input.assigneeUserId)
      : null;
    const [row] = await tx
      .insert(schema.engagementItems)
      .values({
        organizationId: access.sr.organizationId,
        serviceRequestId,
        kind: input.kind,
        title: input.title,
        detail: input.detail ?? null,
        reference: input.reference ?? null,
        severity: input.severity ?? null,
        visibility,
        assigneeUserId: input.assigneeUserId ?? null,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        sortOrder: input.sortOrder ?? 0,
        createdBy: actorId,
      })
      .returning();
    await recordAudit(tx, identity, {
      action: 'engagement_item.created',
      entityType: 'engagement_item',
      entityId: row!.id,
      organizationId: row!.organizationId,
      after: {
        serviceRequestId,
        kind: row!.kind,
        title: row!.title,
        severity: row!.severity,
        visibility: row!.visibility,
        assigneeUserId: row!.assigneeUserId,
      },
      correlationId: options.correlationId,
    });
    const out: OutboxContext = { identity, actorId, options };
    if (assigneeKind) await announceAssignment(tx, out, row!, access, assigneeKind);
    if (rule.notifyCustomerOnCreate && customerCanSee(visibility))
      await announceToCustomer(tx, out, row!, access, 'created');
    const [dto] = await buildItemDtos(tx, identity, ctx, [
      { row: row!, viewer: 'manager', access },
    ]);
    return dto!;
  });
}

export async function updateEngagementItem(
  identity: RequestIdentity,
  id: string,
  input: EngagementItemUpdate,
  options: ServiceOptions = {},
): Promise<EngagementItemDto> {
  const actorId = userIdOf(identity);
  const ctx = ctxFor(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const { row, access, viewer } = await loadItem(tx, identity, id);
    const { expectedVersion, ...changes } = input;
    const allowed = capabilitiesFor(identity, access, row, viewer).editableFields;
    const requested = Object.keys(changes).filter(
      (k) => changes[k as keyof typeof changes] !== undefined,
    );
    if (viewer !== 'manager' && viewer !== 'assignee')
      throw forbidden('only staff managing the request or the assignee update this item');
    assertRequestOpen(access);
    const refused = requested.filter((k) => !allowed.includes(k));
    if (refused.length > 0)
      throw forbidden(
        allowed.length === 0
          ? 'this item can no longer be edited'
          : `you may change ${allowed.join(', ')} on this item, not ${refused.join(', ')}`,
      );
    assertVersion(row.version, expectedVersion);
    const next = {
      title: changes.title ?? row.title,
      detail: changes.detail === undefined ? row.detail : changes.detail,
      reference: changes.reference === undefined ? row.reference : changes.reference,
      severity: changes.severity === undefined ? row.severity : changes.severity,
      visibility: (changes.visibility ?? row.visibility) as ItemVisibility,
      assigneeUserId:
        changes.assigneeUserId === undefined ? row.assigneeUserId : changes.assigneeUserId,
      dueAt:
        changes.dueAt === undefined ? row.dueAt : changes.dueAt ? new Date(changes.dueAt) : null,
      sortOrder: changes.sortOrder ?? row.sortOrder,
    };
    const problems = validateItemFields({
      kind: row.kind,
      title: next.title,
      severity: next.severity,
      visibility: next.visibility,
    });
    if (problems.length > 0)
      throw new ApiError('validation_failed', problems[0]!.message, { details: problems });
    const assigneeChanged = next.assigneeUserId !== row.assigneeUserId;
    const assigneeKind =
      assigneeChanged && next.assigneeUserId
        ? await assertAssignee(tx, ctx, access, next.assigneeUserId)
        : null;
    const [updated] = await tx
      .update(schema.engagementItems)
      .set({ ...next, version: row.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.engagementItems.id, id), eq(schema.engagementItems.version, row.version)))
      .returning();
    if (!updated) throw versionConflict(row.version);
    // Evidence follows the item: widening visibility to the customer shares
    // evidence that was held back; a new assignee can open the existing evidence.
    if (customerCanSee(next.visibility) && !customerCanSee(row.visibility as ItemVisibility)) {
      await shareWithOrganization(tx, ctx, updated, updated.fileIds ?? []);
    }
    if (assigneeChanged && next.assigneeUserId)
      await grantToAssignee(tx, ctx, next.assigneeUserId, updated.fileIds ?? [], actorId);
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const k of requested) {
      before[k] = (row as Record<string, unknown>)[k];
      after[k] = (updated as Record<string, unknown>)[k];
    }
    await recordAudit(tx, identity, {
      action: 'engagement_item.updated',
      entityType: 'engagement_item',
      entityId: id,
      organizationId: row.organizationId,
      before,
      after,
      correlationId: options.correlationId,
    });
    const out: OutboxContext = { identity, actorId, options };
    if (assigneeKind) await announceAssignment(tx, out, updated, access, assigneeKind);
    if (
      kindRule(row.kind).notifyCustomerOnCreate &&
      customerCanSee(next.visibility) &&
      !customerCanSee(row.visibility as ItemVisibility)
    )
      await announceToCustomer(tx, out, updated, access, 'created');
    const reclassified = classifyItemViewer(identity, access, updated) ?? viewer;
    const [dto] = await buildItemDtos(tx, identity, ctx, [
      { row: updated, viewer: reclassified, access },
    ]);
    return dto!;
  });
}

function actorFor(viewer: ItemViewer): ItemActor | null {
  if (viewer === 'manager') return 'manager';
  if (viewer === 'assignee') return 'assignee';
  if (viewer === 'customer') return 'customer';
  return null;
}

export async function transitionEngagementItem(
  identity: RequestIdentity,
  id: string,
  input: EngagementItemTransition,
  options: ServiceOptions = {},
): Promise<EngagementItemDto> {
  const actorId = userIdOf(identity);
  const ctx = ctxFor(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const { row, access, viewer } = await loadItem(tx, identity, id);
    const actor = actorFor(viewer);
    if (!actor) throw forbidden('you can read this item but not change it');
    assertRequestOpen(access);
    assertVersion(row.version, input.expectedVersion);
    const check = evaluateItemTransition({
      kind: row.kind,
      from: row.status,
      to: input.to,
      actor,
      reason: input.reason ?? null,
      reference: row.reference,
      evidenceCount: (row.fileIds ?? []).length,
    });
    if (!check.ok) {
      if (check.code === 'actor_not_allowed') throw forbidden(check.message);
      throw new ApiError('invalid_transition', check.message, {
        details: { code: check.code, from: row.status, to: input.to },
      });
    }
    const now = new Date();
    const resolution = check.resolves
      ? {
          resolvedAt: now,
          resolvedBy: actorId,
          resolutionNote: input.resolutionNote ?? input.reason ?? null,
        }
      : { resolvedAt: null, resolvedBy: null, resolutionNote: null };
    const [updated] = await tx
      .update(schema.engagementItems)
      .set({ status: input.to, ...resolution, version: row.version + 1, updatedAt: now })
      .where(and(eq(schema.engagementItems.id, id), eq(schema.engagementItems.version, row.version)))
      .returning();
    if (!updated) throw versionConflict(row.version);
    await recordAudit(tx, identity, {
      action: 'engagement_item.transitioned',
      entityType: 'engagement_item',
      entityId: id,
      organizationId: row.organizationId,
      before: { status: row.status },
      after: { status: input.to, resolutionNote: resolution.resolutionNote },
      reason: input.reason ?? null,
      correlationId: options.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'engagement_item.transitioned',
      aggregateType: 'engagement_item',
      aggregateId: id,
      organizationId: row.organizationId,
      actorUserId: actorId,
      payload: {
        itemId: id,
        serviceRequestId: row.serviceRequestId,
        kind: row.kind,
        from: row.status,
        to: input.to,
      },
      correlationId: options.correlationId ?? null,
    });
    const [dto] = await buildItemDtos(tx, identity, ctx, [{ row: updated, viewer, access }]);
    return dto!;
  });
}

/** Sets the organisation on evidence so customer-visible items show it to the customer. */
async function shareWithOrganization(
  tx: Transaction,
  ctx: ActorContext,
  row: ItemRow,
  fileIds: string[],
): Promise<void> {
  if (fileIds.length === 0) return;
  await elevated(tx, ctx, async () => {
    const files = await tx
      .select()
      .from(schema.fileObjects)
      .where(inArray(schema.fileObjects.id, fileIds));
    for (const f of files) {
      if (f.organizationId === null && !isSensitivePurpose(f.purpose)) {
        await tx
          .update(schema.fileObjects)
          .set({ organizationId: row.organizationId })
          .where(eq(schema.fileObjects.id, f.id));
      }
    }
  });
}

export async function attachEngagementItemEvidence(
  identity: RequestIdentity,
  id: string,
  input: EngagementItemEvidence,
  options: ServiceOptions = {},
): Promise<EngagementItemDto> {
  const actorId = userIdOf(identity);
  const ctx = ctxFor(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const { row, access, viewer } = await loadItem(tx, identity, id);
    if (!['manager', 'assignee', 'customer'].includes(viewer))
      throw forbidden('you can read this item but not attach evidence to it');
    assertRequestOpen(access);
    const can = capabilitiesFor(identity, access, row, viewer);
    if (!can.attachEvidence) {
      if (viewer === 'customer') {
        const c = customerMayAttach(row);
        throw forbidden(c.ok ? 'your role cannot upload documents for this organisation' : c.message);
      }
      throw new ApiError(
        'invalid_transition',
        `evidence is attached while the item is open (it is ${row.status})`,
      );
    }
    assertVersion(row.version, input.expectedVersion);
    const customer = viewer === 'customer';
    const staff = isStaff(identity);
    const existing = new Set(row.fileIds ?? []);
    const newIds = [...new Set(input.fileIds)].filter((f) => !existing.has(f));
    // Eligibility is decided on the real rows (elevated read), before any write.
    const files = await elevated(tx, ctx, () =>
      newIds.length === 0
        ? Promise.resolve([] as FileRow[])
        : tx.select().from(schema.fileObjects).where(inArray(schema.fileObjects.id, newIds)),
    );
    for (const fileId of newIds) {
      const file = files.find((f) => f.id === fileId);
      const bad = (message: string) =>
        new ApiError('validation_failed', message, {
          details: [{ path: 'fileIds', message: fileId }],
        });
      if (!file || file.deletedAt) throw bad('file not found');
      if (UNUSABLE_FILE_STATUSES.includes(file.status))
        throw new ApiError('file_quarantined', 'this file is not available', {
          details: { fileId, status: file.status },
        });
      if (!ATTACHABLE_PURPOSES.includes(file.purpose) || isSensitivePurpose(file.purpose))
        throw bad('attach request documents or evidence uploads; identity documents are requested separately');
      const own = file.ownerUserId === actorId;
      const onRequest = file.organizationId === row.organizationId;
      if (viewer === 'assignee' && !staff && !own)
        throw bad('attach evidence you uploaded yourself');
      if ((customer || staff) && !own && !onRequest)
        throw bad('the file belongs to another organisation');
      if (!own && onRequest && file.entityType === 'service_request' && file.entityId !== row.serviceRequestId)
        throw bad('the file belongs to another request');
    }
    for (const file of files) {
      const own = file.ownerUserId === actorId;
      if (own && !customer) {
        // The uploader's evidence follows the item's visibility: shared with the
        // customer organisation for customer-visible items, held back otherwise.
        const shareWithCustomer = customerCanSee(row.visibility as ItemVisibility);
        await tx
          .update(schema.fileObjects)
          .set({
            organizationId: shareWithCustomer
              ? row.organizationId
              : file.purpose === 'evidence'
                ? null
                : file.organizationId,
            entityType: 'service_request',
            entityId: row.serviceRequestId,
          })
          .where(eq(schema.fileObjects.id, file.id));
      }
      await tx.insert(schema.evidence).values({
        organizationId: row.organizationId,
        serviceRequestId: row.serviceRequestId,
        fileId: file.id,
        kind: file.declaredMime.startsWith('image/')
          ? 'photo'
          : file.declaredMime.startsWith('video/')
            ? 'video'
            : 'document',
        caption: input.caption ?? row.title,
        capturedAt: input.capturedAt ? new Date(input.capturedAt) : null,
        captureMetadata: { engagementItemId: row.id, source: viewer },
        uploaderUserId: actorId,
        checksumSha256: file.checksumSha256 ?? '',
      });
    }
    if (row.assigneeUserId && row.assigneeUserId !== actorId)
      await grantToAssignee(tx, ctx, row.assigneeUserId, newIds, actorId);
    const nextStatus = customer ? statusAfterCustomerInput(row.status) : row.status;
    const [updated] = await tx
      .update(schema.engagementItems)
      .set({
        fileIds: [...(row.fileIds ?? []), ...newIds],
        status: nextStatus,
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.engagementItems.id, id), eq(schema.engagementItems.version, row.version)))
      .returning();
    if (!updated) throw versionConflict(row.version);
    await recordAudit(tx, identity, {
      action: 'engagement_item.evidence_attached',
      entityType: 'engagement_item',
      entityId: id,
      organizationId: row.organizationId,
      before: { status: row.status, fileCount: (row.fileIds ?? []).length },
      after: { status: nextStatus, fileIds: newIds },
      correlationId: options.correlationId,
    });
    const recipients = staffRecipients(row, access, actorId);
    if (newIds.length > 0 && recipients.length > 0) {
      await appendOutbox(tx, {
        eventType: 'engagement_item.evidence_attached',
        aggregateType: 'engagement_item',
        aggregateId: id,
        organizationId: row.organizationId,
        actorUserId: actorId,
        payload: {
          itemId: id,
          serviceRequestId: row.serviceRequestId,
          reference: access.sr.reference,
          kindLabel: kindRule(row.kind).label,
          fileCount: newIds.length,
          byCustomer: customer,
          recipientUserIds: recipients,
        },
        correlationId: options.correlationId ?? null,
      });
    }
    const [dto] = await buildItemDtos(tx, identity, ctx, [{ row: updated, viewer, access }]);
    return dto!;
  });
}

export async function respondToEngagementItem(
  identity: RequestIdentity,
  id: string,
  input: EngagementItemResponseCreate,
  options: ServiceOptions = {},
): Promise<EngagementItemDto> {
  const actorId = userIdOf(identity);
  const ctx = ctxFor(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const { row, access, viewer } = await loadItem(tx, identity, id);
    if (!['manager', 'assignee', 'customer'].includes(viewer))
      throw forbidden('you can read this item but not reply to it');
    assertRequestOpen(access);
    if (viewer === 'customer') {
      const c = customerMayRespond(row);
      if (!c.ok) throw forbidden(c.message);
      if (!orgAllows(identity, access, 'org.comment'))
        throw forbidden('your role in this organisation cannot answer queries');
    } else if (!OPEN_ITEM_STATUSES.includes(row.status)) {
      throw new ApiError('invalid_transition', `replies are added while the item is open (it is ${row.status})`);
    }
    assertVersion(row.version, input.expectedVersion);
    const customer = viewer === 'customer';
    await tx.insert(schema.notes).values({
      organizationId: row.organizationId,
      entityType: 'engagement_item',
      entityId: row.id,
      body: input.body,
      visibility: row.visibility,
      authorUserId: actorId,
    });
    const nextStatus = customer ? statusAfterCustomerInput(row.status) : row.status;
    const [updated] = await tx
      .update(schema.engagementItems)
      .set({ status: nextStatus, version: row.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.engagementItems.id, id), eq(schema.engagementItems.version, row.version)))
      .returning();
    if (!updated) throw versionConflict(row.version);
    await recordAudit(tx, identity, {
      action: customer ? 'engagement_item.customer_responded' : 'engagement_item.replied',
      entityType: 'engagement_item',
      entityId: id,
      organizationId: row.organizationId,
      before: { status: row.status },
      after: { status: nextStatus, length: input.body.length },
      correlationId: options.correlationId,
    });
    const out: OutboxContext = { identity, actorId, options };
    const recipients = staffRecipients(row, access, actorId);
    if (recipients.length > 0) {
      await appendOutbox(tx, {
        eventType: 'engagement_item.responded',
        aggregateType: 'engagement_item',
        aggregateId: id,
        organizationId: row.organizationId,
        actorUserId: actorId,
        payload: {
          itemId: id,
          serviceRequestId: row.serviceRequestId,
          reference: access.sr.reference,
          kindLabel: kindRule(row.kind).label,
          byCustomer: customer,
          recipientUserIds: recipients,
        },
        correlationId: options.correlationId ?? null,
      });
    }
    if (!customer && customerCanSee(row.visibility as ItemVisibility))
      await announceToCustomer(tx, out, updated, access, 'reply');
    const [dto] = await buildItemDtos(tx, identity, ctx, [{ row: updated, viewer, access }]);
    return dto!;
  });
}
