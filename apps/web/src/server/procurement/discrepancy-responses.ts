import 'server-only';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  ApiError,
  type DiscrepancyDecide,
  type DiscrepancyProposedResolution,
  type DiscrepancyRespond,
  type DiscrepancyResponseState,
  type DiscrepancyThreadDto,
  type DiscrepancyThreadEntry,
} from '@simplexd/contracts';
import {
  appendOutbox,
  getDb,
  schema,
  withActor,
  type DbExecutor,
  type Transaction,
} from '@simplexd/db';
import { kindForMime } from '@simplexd/domain/evidence';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { demote, elevate, userNameMap } from '@/server/assignments/shared';
import { dbNow } from '@/server/tenders/shared';
import {
  ctxFor,
  deliveryLines,
  loadPurchaseOrderAccess,
  requireProcurement,
  toDiscrepancyDto,
  type DeliveryRow,
  type DiscrepancyRow,
  type PurchaseOrderRow,
  type Role,
  type ServiceOptions,
} from './shared';

/**
 * The supplier's side of a delivery discrepancy. Staff raise a discrepancy
 * (`deliveries.ts`); the supplier named on the purchase order replies with a
 * response, a proposed resolution (replace, credit or dispute) and evidence;
 * staff accept the proposal (which closes the discrepancy as resolved,
 * credited or returned) or reject it with a reason, after which the supplier
 * may reply again.
 *
 * Storage without schema changes: every reply and decision is an append-only
 * `notes` row (`entity_type = 'discrepancy_response'`, JSON body, visibility
 * `partner`) and the supplier's files become `evidence` rows linked to the
 * delivery (`evidence.delivery_id`). The discrepancy row itself only ever
 * moves through its existing status enum.
 */

export const DISCREPANCY_RESPONSE_ENTITY = 'discrepancy_response';

interface ResponseBody {
  version: 1;
  kind: 'supplier_response' | 'staff_decision';
  text: string;
  proposedResolution: DiscrepancyProposedResolution | null;
  evidenceFileIds: string[];
  decision: 'accept' | 'reject' | null;
  outcome: 'resolved' | 'credited' | 'returned' | null;
}

type NoteRow = typeof schema.notes.$inferSelect;

const CLOSED: ReadonlySet<DiscrepancyRow['status']> = new Set(['resolved', 'credited', 'returned']);
const OPEN: ReadonlySet<DiscrepancyRow['status']> = new Set(['open', 'supplier_notified']);

function parseBody(row: NoteRow): ResponseBody | null {
  try {
    const raw = JSON.parse(row.body) as Partial<ResponseBody>;
    if (raw.version !== 1 || (raw.kind !== 'supplier_response' && raw.kind !== 'staff_decision'))
      return null;
    return {
      version: 1,
      kind: raw.kind,
      text: typeof raw.text === 'string' ? raw.text : '',
      proposedResolution: raw.proposedResolution ?? null,
      evidenceFileIds: Array.isArray(raw.evidenceFileIds) ? raw.evidenceFileIds : [],
      decision: raw.decision ?? null,
      outcome: raw.outcome ?? null,
    };
  } catch {
    return null;
  }
}

function toEntry(row: NoteRow, body: ResponseBody, names: Map<string, string>) {
  return {
    id: row.id,
    discrepancyId: row.entityId,
    kind: body.kind,
    authorUserId: row.authorUserId,
    authorName: names.get(row.authorUserId) ?? null,
    createdAt: row.createdAt.toISOString(),
    text: body.text,
    proposedResolution: body.proposedResolution,
    evidenceFileIds: body.evidenceFileIds,
    decision: body.decision,
    outcome: body.outcome,
  } satisfies DiscrepancyThreadEntry;
}

export function responseStateOf(
  status: DiscrepancyRow['status'],
  entries: DiscrepancyThreadEntry[],
): DiscrepancyResponseState {
  const last = entries[entries.length - 1];
  if (CLOSED.has(status)) {
    return last?.kind === 'staff_decision' && last.decision === 'accept' ? 'accepted' : 'closed';
  }
  if (!last) return 'awaiting_supplier';
  if (last.kind === 'supplier_response') return 'responded';
  return last.decision === 'reject' ? 'rejected' : 'awaiting_supplier';
}

interface DeliveryAccess {
  delivery: DeliveryRow;
  po: PurchaseOrderRow;
  role: Role;
}

async function loadDeliveryAccess(
  tx: DbExecutor,
  identity: RequestIdentity,
  deliveryId: string,
  options: { customer?: boolean } = {},
): Promise<DeliveryAccess> {
  const [delivery] = await tx
    .select()
    .from(schema.deliveries)
    .where(eq(schema.deliveries.id, deliveryId));
  if (!delivery) throw new ApiError('not_found', 'delivery not found');
  const access = await loadPurchaseOrderAccess(tx, identity, delivery.purchaseOrderId, options);
  return { delivery, ...access };
}

async function loadDiscrepancy(
  tx: DbExecutor,
  deliveryId: string,
  discrepancyId: string,
): Promise<DiscrepancyRow> {
  const [row] = await tx
    .select()
    .from(schema.discrepancies)
    .where(
      and(
        eq(schema.discrepancies.id, discrepancyId),
        eq(schema.discrepancies.deliveryId, deliveryId),
      ),
    );
  if (!row) throw new ApiError('not_found', 'discrepancy not found');
  return row;
}

/**
 * Reads every response row of the given discrepancies. Runs elevated: the
 * `notes` policy shows a partner only their own rows and hides staff
 * decisions, while the caller's access to the delivery was proven under
 * their own context just before.
 */
async function threadsInTx(
  tx: Transaction,
  identity: RequestIdentity,
  access: DeliveryAccess,
  discrepancies: DiscrepancyRow[],
  options: ServiceOptions,
): Promise<DiscrepancyThreadDto[]> {
  if (discrepancies.length === 0) return [];
  const ctx = ctxFor(identity, options);
  const ids = discrepancies.map((d) => d.id);
  await elevate(tx, ctx);
  const rows = await tx
    .select()
    .from(schema.notes)
    .where(
      and(
        eq(schema.notes.entityType, DISCREPANCY_RESPONSE_ENTITY),
        inArray(schema.notes.entityId, ids),
      ),
    )
    .orderBy(asc(schema.notes.createdAt), asc(schema.notes.id));
  const names = await userNameMap(
    tx,
    rows.map((r) => r.authorUserId),
  );
  await demote(tx, ctx);
  const lineOf = new Map<string, string>();
  for (const line of deliveryLines(access.delivery))
    for (const id of line.discrepancyIds) lineOf.set(id, line.lineId);
  return discrepancies.map((d) => {
    const entries = rows
      .filter((r) => r.entityId === d.id)
      .map((r) => {
        const body = parseBody(r);
        return body ? toEntry(r, body, names) : null;
      })
      .filter((e): e is DiscrepancyThreadEntry => e !== null);
    const responseState = responseStateOf(d.status, entries);
    return {
      discrepancy: toDiscrepancyDto(d, lineOf.get(d.id) ?? null),
      responseState,
      entries,
      canRespond: access.role === 'supplier' && OPEN.has(d.status),
      canDecide: access.role === 'staff' && responseState === 'responded',
    };
  });
}

/** Threads for every discrepancy of a delivery (staff, the named supplier, or the ordering organisation). */
export async function listDiscrepancyThreads(
  identity: RequestIdentity,
  deliveryId: string,
  options: ServiceOptions = {},
): Promise<{ items: DiscrepancyThreadDto[] }> {
  requireProcurement(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await loadDeliveryAccess(tx, identity, deliveryId);
    const discrepancies = await tx
      .select()
      .from(schema.discrepancies)
      .where(eq(schema.discrepancies.deliveryId, deliveryId))
      .orderBy(asc(schema.discrepancies.createdAt));
    return { items: await threadsInTx(tx, identity, access, discrepancies, options) };
  });
}

/** Links the supplier's own, scanned files as evidence of the delivery; idempotent per file. */
async function linkSupplierEvidence(
  tx: DbExecutor,
  access: DeliveryAccess,
  discrepancyId: string,
  fileIds: string[],
  uploaderUserId: string,
): Promise<void> {
  if (fileIds.length === 0) return;
  const files = await tx
    .select()
    .from(schema.fileObjects)
    .where(inArray(schema.fileObjects.id, [...new Set(fileIds)]));
  for (const fileId of new Set(fileIds)) {
    const file = files.find((f) => f.id === fileId);
    if (!file || file.ownerUserId !== uploaderUserId) {
      throw new ApiError('validation_failed', 'evidence must be a file you uploaded yourself', {
        details: [{ path: 'evidenceFileIds', message: `unknown file ${fileId}` }],
      });
    }
    if (file.status !== 'clean' || !file.checksumSha256) {
      throw new ApiError(
        file.status === 'clean' ||
        file.status === 'uploaded' ||
        file.status === 'scanning' ||
        file.status === 'pending_upload'
          ? 'file_quarantined'
          : 'file_rejected',
        `the file is ${file.status} and cannot be attached yet`,
        { details: { fileId, status: file.status }, retryable: file.status !== 'infected' },
      );
    }
    await tx
      .insert(schema.evidence)
      .values({
        organizationId: access.po.organizationId,
        projectId: access.po.projectId,
        deliveryId: access.delivery.id,
        fileId,
        kind: kindForMime(file.detectedMime ?? file.declaredMime, file.originalName),
        caption: `Supplier response to discrepancy ${discrepancyId}`,
        uploaderUserId,
        checksumSha256: file.checksumSha256,
        publication: 'restricted',
        offlineClientId: `discrepancy:${discrepancyId}:${fileId}`.slice(0, 128),
      })
      .onConflictDoNothing({ target: schema.evidence.offlineClientId });
  }
}

/** The supplier named on the order replies to a discrepancy raised on one of its deliveries. */
export async function respondToDiscrepancy(
  identity: RequestIdentity,
  deliveryId: string,
  discrepancyId: string,
  input: DiscrepancyRespond,
  options: ServiceOptions = {},
): Promise<DiscrepancyThreadDto> {
  const userId = requireProcurement(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await loadDeliveryAccess(tx, identity, deliveryId, { customer: false });
    if (access.role !== 'supplier')
      throw new ApiError('forbidden', 'only the supplier named on the order can respond');
    const discrepancy = await loadDiscrepancy(tx, deliveryId, discrepancyId);
    if (!OPEN.has(discrepancy.status)) {
      throw new ApiError(
        'invalid_transition',
        `this discrepancy is ${discrepancy.status}; it no longer takes a response`,
      );
    }
    await linkSupplierEvidence(tx, access, discrepancyId, input.evidenceFileIds, userId);
    const body: ResponseBody = {
      version: 1,
      kind: 'supplier_response',
      text: input.response,
      proposedResolution: input.proposedResolution,
      evidenceFileIds: [...new Set(input.evidenceFileIds)],
      decision: null,
      outcome: null,
    };
    const [note] = await tx
      .insert(schema.notes)
      .values({
        organizationId: access.po.organizationId,
        entityType: DISCREPANCY_RESPONSE_ENTITY,
        entityId: discrepancyId,
        body: JSON.stringify(body),
        visibility: 'partner',
        authorUserId: userId,
      })
      .returning();
    // A reply proves the supplier knows about it, whatever staff recorded.
    if (discrepancy.status === 'open') {
      await tx
        .update(schema.discrepancies)
        .set({ status: 'supplier_notified' })
        .where(and(eq(schema.discrepancies.id, discrepancyId), eq(schema.discrepancies.status, 'open')));
    }
    const recipients = [
      access.po.createdBy,
      access.delivery.receivedByUserId,
      discrepancy.createdBy,
    ].filter((v, i, all): v is string => Boolean(v) && all.indexOf(v) === i);
    await appendOutbox(tx, {
      eventType: 'delivery.discrepancy.supplier_responded',
      aggregateType: 'delivery',
      aggregateId: deliveryId,
      organizationId: access.po.organizationId,
      actorUserId: userId,
      payload: {
        purchaseOrderId: access.po.id,
        deliveryId,
        discrepancyId,
        proposedResolution: input.proposedResolution,
        recipientUserIds: recipients,
      },
      correlationId: options.correlationId,
    });
    await recordAudit(tx, identity, {
      action: 'delivery.discrepancy_supplier_responded',
      entityType: 'discrepancy',
      entityId: discrepancyId,
      organizationId: access.po.organizationId,
      after: {
        noteId: note!.id,
        proposedResolution: input.proposedResolution,
        evidenceFileIds: body.evidenceFileIds,
        statusBefore: discrepancy.status,
      },
      correlationId: options.correlationId,
    });
    const [fresh] = await tx
      .select()
      .from(schema.discrepancies)
      .where(eq(schema.discrepancies.id, discrepancyId));
    const [thread] = await threadsInTx(tx, identity, access, [fresh!], options);
    return thread!;
  });
}

/** Staff accept the supplier's proposal (closing the discrepancy) or reject it with a reason. */
export async function decideDiscrepancyResponse(
  identity: RequestIdentity,
  deliveryId: string,
  discrepancyId: string,
  input: DiscrepancyDecide,
  options: ServiceOptions = {},
): Promise<DiscrepancyThreadDto> {
  const userId = requireProcurement(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await loadDeliveryAccess(tx, identity, deliveryId, { customer: false });
    if (access.role !== 'staff') throw new ApiError('forbidden', 'staff action');
    const discrepancy = await loadDiscrepancy(tx, deliveryId, discrepancyId);
    const [current] = await threadsInTx(tx, identity, access, [discrepancy], options);
    if (!current || current.responseState !== 'responded') {
      throw new ApiError(
        'invalid_transition',
        'there is no supplier response awaiting a decision on this discrepancy',
        { details: { responseState: current?.responseState ?? null } },
      );
    }
    const proposal = [...current.entries]
      .reverse()
      .find((e) => e.kind === 'supplier_response')?.proposedResolution;
    const outcome =
      input.decision === 'accept'
        ? (input.outcome ?? (proposal === 'credit' ? 'credited' : 'resolved'))
        : null;
    const now = await dbNow(tx);
    if (outcome) {
      const [updated] = await tx
        .update(schema.discrepancies)
        .set({ status: outcome, resolution: input.reason, resolvedAt: now.date })
        .where(
          and(
            eq(schema.discrepancies.id, discrepancyId),
            eq(schema.discrepancies.status, discrepancy.status),
          ),
        )
        .returning();
      if (!updated) throw new ApiError('conflict', 'the discrepancy changed concurrently; reload');
    }
    const body: ResponseBody = {
      version: 1,
      kind: 'staff_decision',
      text: input.reason,
      proposedResolution: proposal ?? null,
      evidenceFileIds: [],
      decision: input.decision,
      outcome,
    };
    await tx.insert(schema.notes).values({
      organizationId: access.po.organizationId,
      entityType: DISCREPANCY_RESPONSE_ENTITY,
      entityId: discrepancyId,
      body: JSON.stringify(body),
      visibility: 'partner',
      authorUserId: userId,
    });
    await appendOutbox(tx, {
      eventType: 'delivery.discrepancy.decided',
      aggregateType: 'delivery',
      aggregateId: deliveryId,
      organizationId: access.po.organizationId,
      actorUserId: userId,
      payload: {
        purchaseOrderId: access.po.id,
        deliveryId,
        discrepancyId,
        decision: input.decision,
        outcome,
        recipientUserIds: access.po.supplierUserId ? [access.po.supplierUserId] : [],
      },
      correlationId: options.correlationId,
    });
    await recordAudit(tx, identity, {
      action: `delivery.discrepancy_response_${input.decision === 'accept' ? 'accepted' : 'rejected'}`,
      entityType: 'discrepancy',
      entityId: discrepancyId,
      organizationId: access.po.organizationId,
      before: { status: discrepancy.status },
      after: { status: outcome ?? discrepancy.status, proposedResolution: proposal ?? null },
      reason: input.reason,
      correlationId: options.correlationId,
    });
    const [fresh] = await tx
      .select()
      .from(schema.discrepancies)
      .where(eq(schema.discrepancies.id, discrepancyId));
    const [thread] = await threadsInTx(tx, identity, access, [fresh!], options);
    return thread!;
  });
}
