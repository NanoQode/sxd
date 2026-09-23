import 'server-only';
import { and, asc, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import {
  ApiError,
  type ClosingRecordDto,
  type ClosingStep,
  type DiligenceDependencyDto,
  type DiligenceLink,
  type DiligenceWaive,
  type HandoverAcknowledge,
  type PurchaseFeeBasisDto,
  type PurchaseItemCreate,
  type PurchaseItemDto,
  type PurchaseItemUpdate,
  type PurchaseWorkspaceDto,
  type ReportDetailDto,
} from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor, type Transaction } from '@simplexd/db';
import { authorizeStaff } from '@simplexd/domain/authz';
import {
  BLOCKING_RED_FLAG_STATUSES,
  DILIGENCE_LINK_SUBJECT,
  HANDOVER_ACK_NOTE,
  PURCHASE_ITEM_KINDS,
  checkDiligence,
  closingReadiness,
  type ClosingReadiness,
  type DiligenceState,
  type ItemState,
} from '@simplexd/domain/purchase';
import { percentageFeeKobo } from '@simplexd/finance';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import {
  attachEngagementItemEvidence,
  createEngagementItem,
  transitionEngagementItem,
  updateEngagementItem,
} from '@/server/engagements/items';
import { createServiceRequestReport } from '@/server/engagements/reports';
import { elevated } from '@/server/files/access';
import {
  assertVersion,
  ctxFor,
  notFound,
  userIdOf,
  type ServiceOptions,
} from '@/server/projects/shared';
import {
  assertRequestOpen,
  assertWorkflow,
  forbidden,
  requireCustomer,
  requireStaffManage,
  requireWorkspace,
  type WorkspaceAccess,
} from '@/server/search/access';
import { acceptedOfferOf, listOffersForRequest } from './offers';

/**
 * Purchase representation beyond the offer: conditions, the diligence
 * dependency, the closing checklist, document handover and the closing pack.
 *
 * Conditions, closing tasks and handover documents are engagement items
 * (kinds `condition`, `closing_task`, `handover_document`) managed through
 * the generic engagement-items service (@/server/engagements/items); this
 * module adds the purchase rules on top:
 *  - a handover document counts as handed over only when the customer
 *    acknowledged receipt (`acknowledgeHandover`): staff attach the files and
 *    may waive or cancel, but never mark it satisfied themselves;
 *  - the diligence dependency is a `condition` item whose subject is the
 *    due-diligence request of the same customer; it is evaluated live
 *    (unresolved red flags, released diligence memorandum) and can only be
 *    waived by staff holding `service_requests.override`, with a reason;
 *  - closing readiness (`closingReadiness` in @simplexd/domain/purchase)
 *    gates the closing pack: a `closing_pack` report under the request that
 *    a different reviewer approves and releases — together with the agreed
 *    fee basis recorded on the request, the completion evidence of §8.
 */

type ItemRow = typeof schema.engagementItems.$inferSelect;

const PURCHASE_WORKFLOWS = ['purchase_support'];
const OPEN = ['open', 'in_progress'];

/* ---------------------------------------------------------------------- */
/* Items                                                                   */
/* ---------------------------------------------------------------------- */

async function itemsOf(tx: Transaction, ws: WorkspaceAccess): Promise<ItemRow[]> {
  const rows = await tx
    .select()
    .from(schema.engagementItems)
    .where(
      and(
        eq(schema.engagementItems.serviceRequestId, ws.access.sr.id),
        inArray(schema.engagementItems.kind, [...PURCHASE_ITEM_KINDS]),
      ),
    )
    .orderBy(asc(schema.engagementItems.sortOrder), asc(schema.engagementItems.createdAt));
  // Row-level security already hides internal items from customers; keep the rule explicit.
  return ws.viewer === 'customer'
    ? rows.filter((r) => r.visibility === 'customer' || r.visibility === 'all')
    : rows;
}

function isDiligenceLink(row: ItemRow): boolean {
  return row.kind === 'condition' && row.subjectType === DILIGENCE_LINK_SUBJECT;
}

async function memberIds(tx: Transaction, organizationId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ userId: schema.member.userId })
    .from(schema.member)
    .where(eq(schema.member.organizationId, organizationId));
  return new Set(rows.map((r) => r.userId));
}

/** A handover document is acknowledged when a member of the customer organisation marked it received. */
function acknowledgedBy(row: ItemRow, members: Set<string>): boolean {
  return (
    row.kind === 'handover_document' &&
    row.status === 'satisfied' &&
    row.resolutionNote === HANDOVER_ACK_NOTE &&
    row.resolvedBy !== null &&
    members.has(row.resolvedBy)
  );
}

async function toItemDtos(
  tx: Transaction,
  ws: WorkspaceAccess,
  rows: ItemRow[],
): Promise<PurchaseItemDto[]> {
  if (rows.length === 0) return [];
  const fileIds = [...new Set(rows.flatMap((r) => r.fileIds ?? []))];
  const files = new Map(
    fileIds.length === 0
      ? []
      : (
          await tx
            .select({
              id: schema.fileObjects.id,
              name: schema.fileObjects.originalName,
              status: schema.fileObjects.status,
            })
            .from(schema.fileObjects)
            .where(
              and(inArray(schema.fileObjects.id, fileIds), isNull(schema.fileObjects.deletedAt)),
            )
        ).map((f) => [f.id, f]),
  );
  const userIds = [...new Set(rows.map((r) => r.resolvedBy).filter((v): v is string => !!v))];
  const names = new Map(
    userIds.length === 0
      ? []
      : (
          await tx
            .select({ id: schema.user.id, name: schema.user.name })
            .from(schema.user)
            .where(inArray(schema.user.id, userIds))
        ).map((u) => [u.id, u.name]),
  );
  const members = await memberIds(tx, ws.access.sr.organizationId);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as PurchaseItemDto['kind'],
    title: r.title,
    detail: r.detail,
    reference: r.reference,
    status: r.status,
    visibility: r.visibility,
    dueAt: r.dueAt?.toISOString() ?? null,
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    resolvedByName: r.resolvedBy ? (names.get(r.resolvedBy) ?? null) : null,
    resolutionNote: r.resolutionNote,
    files: (r.fileIds ?? []).flatMap((id) => {
      const f = files.get(id);
      return f ? [{ id: f.id, name: f.name, status: f.status }] : [];
    }),
    offerId: r.subjectType === 'offer' ? r.subjectId : null,
    acknowledged: acknowledgedBy(r, members),
    version: r.version,
    createdAt: r.createdAt.toISOString(),
  }));
}

async function loadPurchaseItem(
  tx: Transaction,
  identity: RequestIdentity,
  id: string,
): Promise<{ row: ItemRow; ws: WorkspaceAccess }> {
  const [row] = await tx
    .select()
    .from(schema.engagementItems)
    .where(eq(schema.engagementItems.id, id));
  if (!row || !(PURCHASE_ITEM_KINDS as readonly string[]).includes(row.kind))
    throw notFound('item');
  const ws = await requireWorkspace(tx, identity, row.serviceRequestId);
  if (ws.viewer === 'customer' && row.visibility !== 'customer' && row.visibility !== 'all') {
    throw notFound('item');
  }
  return { row, ws };
}

/** Staff add a condition, closing task or handover document. */
export async function createPurchaseItem(
  identity: RequestIdentity,
  serviceRequestId: string,
  input: PurchaseItemCreate,
  options: ServiceOptions = {},
): Promise<PurchaseItemDto> {
  const actorId = userIdOf(identity);
  await withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const ws = await requireWorkspace(tx, identity, serviceRequestId);
    assertWorkflow(ws, PURCHASE_WORKFLOWS);
    requireStaffManage(identity, ws);
    assertRequestOpen(ws);
  });
  const created = await createEngagementItem(
    identity,
    serviceRequestId,
    {
      kind: input.kind,
      title: input.title,
      detail: input.detail ?? null,
      reference: input.reference ?? null,
      dueAt: input.dueAt ?? null,
      visibility: input.visibility,
    },
    options,
  );
  let version = created.version;
  if (input.fileIds.length > 0) {
    const withFiles = await attachEngagementItemEvidence(
      identity,
      created.id,
      { fileIds: input.fileIds, expectedVersion: version },
      options,
    );
    version = withFiles.version;
  }
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { row, ws } = await loadPurchaseItem(tx, identity, created.id);
    if (input.visibility !== 'internal') {
      await appendOutbox(tx, {
        eventType: 'purchase_item.created',
        aggregateType: 'engagement_item',
        aggregateId: row.id,
        organizationId: row.organizationId,
        actorUserId: actorId,
        payload: { itemId: row.id, serviceRequestId, kind: row.kind, title: row.title },
        correlationId: options.correlationId ?? null,
      });
      if (row.kind === 'handover_document' && (row.fileIds ?? []).length > 0) {
        await announceHandoverReady(tx, identity, row, options);
      }
    }
    const [dto] = await toItemDtos(tx, ws, [row]);
    return dto!;
  });
}

async function announceHandoverReady(
  tx: Transaction,
  identity: RequestIdentity,
  row: ItemRow,
  options: ServiceOptions,
): Promise<void> {
  await appendOutbox(tx, {
    eventType: 'purchase_handover.ready',
    aggregateType: 'engagement_item',
    aggregateId: row.id,
    organizationId: row.organizationId,
    actorUserId: identity.session?.user.id ?? null,
    payload: { itemId: row.id, serviceRequestId: row.serviceRequestId, title: row.title },
    correlationId: options.correlationId ?? null,
  });
}

/**
 * Staff update: fields, attached files and status. Handover documents are
 * never marked satisfied by staff (the customer acknowledges receipt) and the
 * diligence link changes only through `linkDiligence` / `waiveDiligence`.
 */
export async function updatePurchaseItem(
  identity: RequestIdentity,
  id: string,
  input: PurchaseItemUpdate,
  options: ServiceOptions = {},
): Promise<PurchaseItemDto> {
  const before = await withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { row, ws } = await loadPurchaseItem(tx, identity, id);
    requireStaffManage(identity, ws);
    assertRequestOpen(ws);
    assertVersion(row.version, input.expectedVersion);
    if (isDiligenceLink(row)) {
      throw new ApiError(
        'invalid_transition',
        'the diligence dependency is evaluated from the linked request; relink or waive it instead',
      );
    }
    if (row.kind === 'handover_document' && input.status === 'satisfied') {
      throw new ApiError(
        'invalid_transition',
        'a handover document is satisfied when the customer acknowledges receipt',
      );
    }
    return row;
  });
  let version = input.expectedVersion;
  if (
    input.title !== undefined ||
    input.detail !== undefined ||
    input.reference !== undefined ||
    input.dueAt !== undefined
  ) {
    const updated = await updateEngagementItem(
      identity,
      id,
      {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        ...(input.reference !== undefined ? { reference: input.reference } : {}),
        ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
        expectedVersion: version,
      },
      options,
    );
    version = updated.version;
  }
  let filesAdded = false;
  if (input.addFileIds && input.addFileIds.length > 0) {
    const updated = await attachEngagementItemEvidence(
      identity,
      id,
      { fileIds: input.addFileIds, expectedVersion: version },
      options,
    );
    filesAdded = updated.version !== version;
    version = updated.version;
  }
  if (input.status && input.status !== before.status) {
    const updated = await transitionEngagementItem(
      identity,
      id,
      { to: input.status, reason: input.reason, expectedVersion: version },
      options,
    );
    version = updated.version;
  } else if (before.kind === 'handover_document' && filesAdded && before.status === 'open') {
    // Files are on it: the document is handed over and awaits acknowledgement.
    const updated = await transitionEngagementItem(
      identity,
      id,
      { to: 'in_progress', expectedVersion: version },
      options,
    );
    version = updated.version;
  }
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { row, ws } = await loadPurchaseItem(tx, identity, id);
    if (
      row.kind === 'handover_document' &&
      filesAdded &&
      OPEN.includes(row.status) &&
      (row.visibility === 'customer' || row.visibility === 'all')
    ) {
      await announceHandoverReady(tx, identity, row, options);
    }
    const [dto] = await toItemDtos(tx, ws, [row]);
    return dto!;
  });
}

/** The customer acknowledges receipt of a handover document that carries files. */
export async function acknowledgeHandover(
  identity: RequestIdentity,
  id: string,
  input: HandoverAcknowledge,
  options: ServiceOptions = {},
): Promise<PurchaseItemDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { row, ws } = await loadPurchaseItem(tx, identity, id);
    requireCustomer(identity, ws, 'org.documents.view');
    assertRequestOpen(ws);
    assertVersion(row.version, input.expectedVersion);
    if (row.kind !== 'handover_document') {
      throw new ApiError('invalid_transition', 'only handover documents are acknowledged');
    }
    if (!OPEN.includes(row.status)) {
      throw new ApiError('invalid_transition', `this document is already ${row.status}`);
    }
    if ((row.fileIds ?? []).length === 0) {
      throw new ApiError('invalid_transition', 'no file has been handed over on this document yet');
    }
    const now = new Date();
    const [updated] = await tx
      .update(schema.engagementItems)
      .set({
        status: 'satisfied',
        resolvedAt: now,
        resolvedBy: actorId,
        resolutionNote: HANDOVER_ACK_NOTE,
        version: row.version + 1,
        updatedAt: now,
      })
      .where(
        and(eq(schema.engagementItems.id, id), eq(schema.engagementItems.version, row.version)),
      )
      .returning();
    if (!updated)
      throw new ApiError('version_conflict', 'this document changed; reload and try again');
    await recordAudit(tx, identity, {
      action: 'purchase_handover.acknowledged',
      entityType: 'engagement_item',
      entityId: id,
      organizationId: row.organizationId,
      before: { status: row.status },
      after: { status: 'satisfied', fileIds: row.fileIds },
      correlationId: options.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'purchase_handover.acknowledged',
      aggregateType: 'engagement_item',
      aggregateId: id,
      organizationId: row.organizationId,
      actorUserId: actorId,
      payload: {
        itemId: id,
        serviceRequestId: row.serviceRequestId,
        title: row.title,
        recipientUserIds: ws.access.staffAssigneeIds,
      },
      correlationId: options.correlationId ?? null,
    });
    const [dto] = await toItemDtos(tx, ws, [updated]);
    return dto!;
  });
}

/* ---------------------------------------------------------------------- */
/* Diligence dependency                                                    */
/* ---------------------------------------------------------------------- */

interface DiligenceFacts {
  link: ItemRow | null;
  request: { id: string; reference: string; title: string; status: string } | null;
  state: DiligenceState;
  openRedFlags: number;
}

/**
 * Evaluates the linked due-diligence request. Red flags are counted whatever
 * their visibility (an internal red flag blocks closing too), so the count is
 * read with elevated rights and only exposed to staff.
 */
async function diligenceFacts(
  tx: Transaction,
  identity: RequestIdentity,
  ws: WorkspaceAccess,
  items: ItemRow[],
): Promise<DiligenceFacts> {
  const link = items.find((i) => isDiligenceLink(i) && i.status !== 'cancelled') ?? null;
  const waived = link?.status === 'waived';
  if (!link || !link.subjectId) {
    return {
      link,
      request: null,
      openRedFlags: 0,
      state: { linked: false, waived, openRedFlags: 0, memoReleased: false },
    };
  }
  const facts = await elevated(tx, ctxFor(identity), async () => {
    const [dd] = await tx
      .select({
        id: schema.serviceRequests.id,
        reference: schema.serviceRequests.reference,
        title: schema.serviceRequests.title,
        status: schema.serviceRequests.status,
        organizationId: schema.serviceRequests.organizationId,
      })
      .from(schema.serviceRequests)
      .where(eq(schema.serviceRequests.id, link.subjectId!));
    if (!dd || dd.organizationId !== ws.access.sr.organizationId) return null;
    const flags = await tx
      .select({ id: schema.engagementItems.id })
      .from(schema.engagementItems)
      .where(
        and(
          eq(schema.engagementItems.serviceRequestId, dd.id),
          eq(schema.engagementItems.kind, 'red_flag'),
          inArray(schema.engagementItems.status, [...BLOCKING_RED_FLAG_STATUSES]),
        ),
      );
    const memos = await tx
      .select({ id: schema.reports.id })
      .from(schema.reports)
      .where(
        and(
          eq(schema.reports.serviceRequestId, dd.id),
          eq(schema.reports.kind, 'diligence_memo'),
          eq(schema.reports.status, 'released'),
        ),
      );
    return { dd, openRedFlags: flags.length, memoReleased: memos.length > 0 };
  });
  if (!facts) {
    return {
      link,
      request: null,
      openRedFlags: 0,
      state: { linked: false, waived, openRedFlags: 0, memoReleased: false },
    };
  }
  return {
    link,
    request: {
      id: facts.dd.id,
      reference: facts.dd.reference,
      title: facts.dd.title,
      status: facts.dd.status,
    },
    openRedFlags: facts.openRedFlags,
    state: {
      linked: true,
      waived,
      openRedFlags: facts.openRedFlags,
      memoReleased: facts.memoReleased,
      requestClosedWithoutDelivery: ['cancelled', 'rejected'].includes(facts.dd.status),
    },
  };
}

async function diligenceCandidates(
  tx: Transaction,
  ws: WorkspaceAccess,
): Promise<DiligenceDependencyDto['candidates']> {
  if (ws.viewer !== 'staff') return [];
  const rows = await tx
    .select({
      id: schema.serviceRequests.id,
      reference: schema.serviceRequests.reference,
      title: schema.serviceRequests.title,
      status: schema.serviceRequests.status,
    })
    .from(schema.serviceRequests)
    .innerJoin(schema.services, eq(schema.services.id, schema.serviceRequests.serviceId))
    .where(
      and(
        eq(schema.serviceRequests.organizationId, ws.access.sr.organizationId),
        eq(schema.services.workflowTemplateKey, 'due_diligence'),
        ne(schema.serviceRequests.id, ws.access.sr.id),
      ),
    )
    .orderBy(desc(schema.serviceRequests.createdAt))
    .limit(20);
  return rows;
}

function diligenceDto(
  facts: DiligenceFacts,
  ws: WorkspaceAccess,
  candidates: DiligenceDependencyDto['candidates'],
): DiligenceDependencyDto {
  const check = checkDiligence(facts.state);
  return {
    linked: facts.state.linked,
    request: facts.request,
    waived: facts.state.waived,
    waiverReason: facts.state.waived ? (facts.link?.resolutionNote ?? null) : null,
    openRedFlags: ws.viewer === 'staff' ? facts.openRedFlags : null,
    memoReleased: facts.state.memoReleased,
    clear: check.clear,
    blockers: check.blockers,
    candidates,
  };
}

/** Staff link the customer's due-diligence request as the closing dependency. */
export async function linkDiligence(
  identity: RequestIdentity,
  serviceRequestId: string,
  input: DiligenceLink,
  options: ServiceOptions = {},
): Promise<DiligenceDependencyDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const ws = await requireWorkspace(tx, identity, serviceRequestId);
    assertWorkflow(ws, PURCHASE_WORKFLOWS);
    requireStaffManage(identity, ws);
    assertRequestOpen(ws);
    if (input.diligenceRequestId === serviceRequestId) {
      throw new ApiError('validation_failed', 'a request cannot depend on itself');
    }
    const [dd] = await tx
      .select({
        id: schema.serviceRequests.id,
        organizationId: schema.serviceRequests.organizationId,
        key: schema.services.workflowTemplateKey,
      })
      .from(schema.serviceRequests)
      .innerJoin(schema.services, eq(schema.services.id, schema.serviceRequests.serviceId))
      .where(eq(schema.serviceRequests.id, input.diligenceRequestId));
    if (!dd) throw notFound('due-diligence request');
    if (dd.organizationId !== ws.access.sr.organizationId) {
      throw new ApiError(
        'validation_failed',
        'the diligence request must belong to the same customer',
        {
          details: [{ path: 'diligenceRequestId', message: 'different organisation' }],
        },
      );
    }
    if (dd.key !== 'due_diligence') {
      throw new ApiError(
        'validation_failed',
        'the linked request must be a due-diligence request',
        {
          details: [{ path: 'diligenceRequestId', message: 'not a due-diligence request' }],
        },
      );
    }
    const items = await itemsOf(tx, ws);
    const existing = items.find((i) => isDiligenceLink(i) && i.status !== 'cancelled');
    const now = new Date();
    if (existing) {
      await tx
        .update(schema.engagementItems)
        .set({
          subjectId: dd.id,
          status: 'open',
          resolvedAt: null,
          resolvedBy: null,
          resolutionNote: null,
          version: existing.version + 1,
          updatedAt: now,
        })
        .where(eq(schema.engagementItems.id, existing.id));
    } else {
      await tx.insert(schema.engagementItems).values({
        organizationId: ws.access.sr.organizationId,
        serviceRequestId,
        kind: 'condition',
        title: 'Due diligence cleared',
        detail:
          'Closing depends on the linked due-diligence request: no unresolved red flags and a released diligence memorandum.',
        visibility: 'customer',
        subjectType: DILIGENCE_LINK_SUBJECT,
        subjectId: dd.id,
        sortOrder: -1,
        createdBy: actorId,
      });
    }
    await recordAudit(tx, identity, {
      action: 'purchase_diligence.linked',
      entityType: 'service_request',
      entityId: serviceRequestId,
      organizationId: ws.access.sr.organizationId,
      before: { diligenceRequestId: existing?.subjectId ?? null },
      after: { diligenceRequestId: dd.id },
      correlationId: options.correlationId,
    });
    const fresh = await itemsOf(tx, ws);
    return diligenceDto(
      await diligenceFacts(tx, identity, ws, fresh),
      ws,
      await diligenceCandidates(tx, ws),
    );
  });
}

/** Waives the diligence dependency (staff `service_requests.override`, reason recorded). */
export async function waiveDiligence(
  identity: RequestIdentity,
  serviceRequestId: string,
  input: DiligenceWaive,
  options: ServiceOptions = {},
): Promise<DiligenceDependencyDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const ws = await requireWorkspace(tx, identity, serviceRequestId);
    assertWorkflow(ws, PURCHASE_WORKFLOWS);
    requireStaffManage(identity, ws);
    assertRequestOpen(ws);
    const decision = authorizeStaff(identity.actor, 'service_requests.override', {
      type: 'service_request',
      id: serviceRequestId,
      organizationId: ws.access.sr.organizationId,
      assigneeUserIds: ws.access.staffAssigneeIds,
    });
    if (!decision.allowed)
      throw forbidden('waiving the diligence dependency needs service_requests.override');
    const items = await itemsOf(tx, ws);
    const existing = items.find((i) => isDiligenceLink(i) && i.status !== 'cancelled');
    const now = new Date();
    if (existing) {
      await tx
        .update(schema.engagementItems)
        .set({
          status: 'waived',
          resolvedAt: now,
          resolvedBy: actorId,
          resolutionNote: input.reason,
          version: existing.version + 1,
          updatedAt: now,
        })
        .where(eq(schema.engagementItems.id, existing.id));
    } else {
      await tx.insert(schema.engagementItems).values({
        organizationId: ws.access.sr.organizationId,
        serviceRequestId,
        kind: 'condition',
        title: 'Due diligence dependency waived',
        detail:
          'Closing proceeds without a linked due-diligence request (see the recorded reason).',
        status: 'waived',
        resolvedAt: now,
        resolvedBy: actorId,
        resolutionNote: input.reason,
        visibility: 'customer',
        subjectType: DILIGENCE_LINK_SUBJECT,
        subjectId: null,
        sortOrder: -1,
        createdBy: actorId,
      });
    }
    await recordAudit(tx, identity, {
      action: 'purchase_diligence.waived',
      entityType: 'service_request',
      entityId: serviceRequestId,
      organizationId: ws.access.sr.organizationId,
      reason: input.reason,
      correlationId: options.correlationId,
    });
    const fresh = await itemsOf(tx, ws);
    return diligenceDto(
      await diligenceFacts(tx, identity, ws, fresh),
      ws,
      await diligenceCandidates(tx, ws),
    );
  });
}

/* ---------------------------------------------------------------------- */
/* Fee basis, readiness and the closing pack                               */
/* ---------------------------------------------------------------------- */

interface StoredFeeBasis {
  percentageBps?: number;
  basisAmountKobo?: string;
  basisDescription?: string;
  basisKind?: string;
  signedScopeFileId?: string;
  agreedAt?: string;
}

function feeBasisDto(sr: typeof schema.serviceRequests.$inferSelect): PurchaseFeeBasisDto {
  const fb = (sr.feeBasis ?? {}) as StoredFeeBasis;
  const fee = percentageFeeKobo({
    ...(fb.percentageBps !== undefined ? { percentageBps: fb.percentageBps } : {}),
    ...(fb.basisAmountKobo ? { basisAmountKobo: fb.basisAmountKobo } : {}),
  });
  return {
    percentageBps: fb.percentageBps ?? null,
    basisAmountKobo: fb.basisAmountKobo ?? null,
    basisDescription: fb.basisDescription ?? null,
    signedScopeFileId: fb.signedScopeFileId ?? null,
    agreedAt: fb.agreedAt ?? null,
    feeKobo: fee === null || !fb.agreedAt ? null : fee.toString(),
  };
}

function feeBasisAgreed(dto: PurchaseFeeBasisDto): boolean {
  return dto.feeKobo !== null && dto.agreedAt !== null && dto.signedScopeFileId !== null;
}

function itemState(r: ItemRow): ItemState {
  return { id: r.id, title: r.title, status: r.status, fileCount: (r.fileIds ?? []).length };
}

async function readinessOf(
  tx: Transaction,
  identity: RequestIdentity,
  ws: WorkspaceAccess,
  items: ItemRow[],
): Promise<{
  readiness: ClosingReadiness;
  diligence: DiligenceFacts;
  acceptedOfferId: string | null;
}> {
  const accepted = await acceptedOfferOf(tx, ws.access.sr.id);
  const diligence = await diligenceFacts(tx, identity, ws, items);
  const members = await memberIds(tx, ws.access.sr.organizationId);
  const readiness = closingReadiness({
    acceptedOfferId: accepted?.id ?? null,
    conditions: items.filter((i) => i.kind === 'condition' && !isDiligenceLink(i)).map(itemState),
    diligence: diligence.state,
    closingTasks: items.filter((i) => i.kind === 'closing_task').map(itemState),
    handoverDocuments: items
      .filter((i) => i.kind === 'handover_document')
      .map((i) => ({ ...itemState(i), acknowledged: acknowledgedBy(i, members) })),
    feeBasisAgreed: feeBasisAgreed(feeBasisDto(ws.access.sr)),
  });
  return { readiness, diligence, acceptedOfferId: accepted?.id ?? null };
}

async function closingRecords(tx: Transaction, ws: WorkspaceAccess): Promise<ClosingRecordDto[]> {
  const reports = await tx
    .select()
    .from(schema.reports)
    .where(
      and(
        eq(schema.reports.serviceRequestId, ws.access.sr.id),
        eq(schema.reports.kind, 'closing_pack'),
        ne(schema.reports.status, 'superseded'),
      ),
    )
    .orderBy(desc(schema.reports.createdAt));
  const out: ClosingRecordDto[] = [];
  for (const report of reports) {
    const version = report.releasedVersion ?? report.currentVersion;
    const [rev] = await tx
      .select({
        findings: schema.reportRevisions.findings,
        summary: schema.reportRevisions.summary,
      })
      .from(schema.reportRevisions)
      .where(
        and(
          eq(schema.reportRevisions.reportId, report.id),
          eq(schema.reportRevisions.version, version),
        ),
      );
    const findings =
      rev?.findings && typeof rev.findings === 'object'
        ? (rev.findings as Record<string, unknown>)
        : {};
    const closing = (findings['closing'] ?? {}) as Record<string, unknown>;
    const docs = Array.isArray(closing['handedOverDocuments'])
      ? (closing['handedOverDocuments'] as Array<{ id: string; title: string }>)
      : [];
    const byId = report.status === 'released' ? report.releasedBy : report.createdBy;
    const [by] = byId
      ? await tx
          .select({ name: schema.user.name })
          .from(schema.user)
          .where(eq(schema.user.id, byId))
      : [];
    out.push({
      reportId: report.id,
      reportStatus: report.status,
      stage: report.status === 'released' ? 'approved' : 'submitted',
      at: (report.releasedAt ?? report.createdAt).toISOString(),
      byName: by?.name ?? null,
      note: rev?.summary ?? null,
      handedOverDocuments: docs,
      acceptedOfferId:
        typeof closing['acceptedOfferId'] === 'string' ? closing['acceptedOfferId'] : null,
      feeBasis: closing['feeBasis'] ?? null,
    });
  }
  return out;
}

/** Everything the purchase tab shows. */
export async function getPurchaseWorkspace(
  identity: RequestIdentity,
  serviceRequestId: string,
): Promise<PurchaseWorkspaceDto> {
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    const ws = await requireWorkspace(tx, identity, serviceRequestId);
    const items = await itemsOf(tx, ws);
    const dtos = await toItemDtos(tx, ws, items);
    const byId = new Map(dtos.map((d) => [d.id, d]));
    const { readiness, diligence } = await readinessOf(tx, identity, ws, items);
    return {
      serviceRequestId,
      serviceRequestVersion: ws.access.sr.version,
      engagementStatus: ws.access.sr.status,
      offers: await listOffersForRequest(tx, ws),
      conditions: items
        .filter((i) => i.kind === 'condition' && !isDiligenceLink(i))
        .map((i) => byId.get(i.id)!),
      closingTasks: items.filter((i) => i.kind === 'closing_task').map((i) => byId.get(i.id)!),
      handoverDocuments: items
        .filter((i) => i.kind === 'handover_document')
        .map((i) => byId.get(i.id)!),
      diligence: diligenceDto(diligence, ws, await diligenceCandidates(tx, ws)),
      readiness,
      feeBasis: feeBasisDto(ws.access.sr),
      closing: await closingRecords(tx, ws),
      viewer: ws.viewer,
    };
  });
}

/** Closing readiness alone (the check function the closing pack and tests use). */
export async function getClosingReadiness(
  identity: RequestIdentity,
  serviceRequestId: string,
): Promise<ClosingReadiness> {
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    const ws = await requireWorkspace(tx, identity, serviceRequestId);
    const items = await itemsOf(tx, ws);
    return (await readinessOf(tx, identity, ws, items)).readiness;
  });
}

function money(kobo: bigint | string | null | undefined): string {
  if (kobo === null || kobo === undefined) return 'not recorded';
  const value = typeof kobo === 'bigint' ? kobo : BigInt(kobo);
  return `₦${(value / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/**
 * Prepares the closing pack once every blocker is cleared: a `closing_pack`
 * report under the request with the transaction, conditions, checklist,
 * handed-over documents and the agreed fee basis. It then follows the report
 * lifecycle (named reviewer, review, release by someone other than the
 * author); the released pack is the approved closing pack.
 */
export async function prepareClosingPack(
  identity: RequestIdentity,
  serviceRequestId: string,
  input: ClosingStep,
  options: ServiceOptions = {},
): Promise<ReportDetailDto> {
  const prepared = await withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const ws = await requireWorkspace(tx, identity, serviceRequestId);
    assertWorkflow(ws, PURCHASE_WORKFLOWS);
    requireStaffManage(identity, ws);
    assertRequestOpen(ws);
    assertVersion(ws.access.sr.version, input.expectedVersion);
    const items = await itemsOf(tx, ws);
    const { readiness, diligence, acceptedOfferId } = await readinessOf(tx, identity, ws, items);
    if (!readiness.ready) {
      throw new ApiError(
        'insufficient_evidence',
        'closing is blocked until every item below is resolved',
        {
          details: readiness.blockers,
        },
      );
    }
    const existing = await tx
      .select({ id: schema.reports.id, status: schema.reports.status })
      .from(schema.reports)
      .where(
        and(
          eq(schema.reports.serviceRequestId, serviceRequestId),
          eq(schema.reports.kind, 'closing_pack'),
          ne(schema.reports.status, 'superseded'),
        ),
      );
    if (existing.length > 0) {
      throw new ApiError('conflict', `a closing pack already exists (${existing[0]!.status})`, {
        details: { reportId: existing[0]!.id },
      });
    }
    const offers = await listOffersForRequest(tx, ws);
    const accepted = offers.find((o) => o.id === acceptedOfferId) ?? null;
    const dtos = await toItemDtos(
      tx,
      ws,
      items.filter((i) => !isDiligenceLink(i)),
    );
    return { ws, items: dtos, accepted, diligence, feeBasis: feeBasisDto(ws.access.sr) };
  });
  const { ws, items, accepted, diligence, feeBasis } = prepared;
  const conditions = items.filter((i) => i.kind === 'condition');
  const tasks = items.filter((i) => i.kind === 'closing_task');
  const docs = items.filter((i) => i.kind === 'handover_document' && i.acknowledged);
  const line = (i: PurchaseItemDto) =>
    `- ${i.title} — ${i.status.replace(/_/g, ' ')}${i.resolutionNote && i.status !== 'satisfied' ? ` (${i.resolutionNote})` : ''}`;
  const body = [
    '## Transaction and accepted offer',
    '',
    accepted
      ? `Offer of ${money(accepted.amountKobo)} on ${accepted.subjectTitle}${accepted.externalReference ? ` (${accepted.externalReference})` : ''}, accepted ${accepted.decidedAt?.slice(0, 10) ?? ''}.`
      : 'No accepted offer.',
    '',
    '## Conditions and diligence dependency',
    '',
    conditions.length === 0 ? 'No conditions were recorded.' : conditions.map(line).join('\n'),
    '',
    diligence.state.waived
      ? `Diligence dependency waived: ${diligence.link?.resolutionNote ?? 'reason recorded'}.`
      : `Due-diligence request ${diligence.request?.reference ?? ''}: no unresolved red flags; diligence memorandum released.`,
    '',
    '## Closing checklist',
    '',
    tasks.length === 0 ? 'No closing tasks were recorded.' : tasks.map(line).join('\n'),
    '',
    '## Documents handed over',
    '',
    docs.length === 0
      ? 'No documents were handed over.'
      : docs
          .map(
            (d) =>
              `- ${d.title}: ${d.files.map((f) => f.name).join(', ')} (receipt acknowledged ${d.resolvedAt?.slice(0, 10) ?? ''})`,
          )
          .join('\n'),
    '',
    '## Agreed fee basis',
    '',
    `${((feeBasis.percentageBps ?? 0) / 100).toFixed(2)}% of ${feeBasis.basisDescription ?? 'the agreed basis'} (${money(feeBasis.basisAmountKobo)}), fee ${money(feeBasis.feeKobo)}, agreed ${feeBasis.agreedAt?.slice(0, 10) ?? ''} with the signed scope on file.`,
    '',
    ...(input.note ? ['', input.note] : []),
  ].join('\n');
  return createServiceRequestReport(
    identity,
    serviceRequestId,
    {
      kind: 'closing_pack',
      title: `Closing pack — ${ws.access.sr.reference}`,
      referenceItems: true,
      initialRevision: {
        summary:
          input.note ??
          `Closing pack for ${ws.access.sr.reference}: accepted offer, cleared conditions, completed checklist, acknowledged handover and agreed fee basis.`,
        bodyMarkdown: body,
        findings: {
          closing: {
            acceptedOfferId: accepted?.id ?? null,
            acceptedAmountKobo: accepted?.amountKobo ?? null,
            conditions: conditions.map((c) => ({ id: c.id, title: c.title, status: c.status })),
            closingTasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
            handedOverDocuments: docs.map((d) => ({
              id: d.id,
              title: d.title,
              fileIds: d.files.map((f) => f.id),
              acknowledgedAt: d.resolvedAt,
            })),
            diligence: {
              requestId: diligence.request?.id ?? null,
              waived: diligence.state.waived,
              memoReleased: diligence.state.memoReleased,
            },
            feeBasis,
          },
        },
        attachmentFileIds: docs.flatMap((d) => d.files.map((f) => f.id)).slice(0, 200),
      },
    },
    options,
  );
}
