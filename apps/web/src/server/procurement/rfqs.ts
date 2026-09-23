import 'server-only';
import { and, asc, desc, eq, inArray, lt, or } from 'drizzle-orm';
import {
  ApiError,
  type Page,
  type RfqComparisonDto,
  type RfqCreate,
  type RfqDetail,
  type RfqDto,
  type RfqItemDto,
  type RfqItemInput,
  type RfqListQuery,
  type RfqResponseDto,
  type RfqResponseSubmit,
} from '@simplexd/contracts';
import {
  appendOutbox,
  getDb,
  schema,
  withActor,
  type DbExecutor,
  type Transaction,
} from '@simplexd/db';
import { assertAllowed, authorizeOrg, authorizeStaff } from '@simplexd/domain/authz';
import {
  compareDeliveredCost,
  type ResponseInput,
  type RfqItemSpec,
} from '@simplexd/domain/procurement';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { decodeCursor, encodeCursor } from '@/server/portal/elevate';
import { allocateCommercialReference, dbNow } from '@/server/tenders/shared';
import {
  ctxFor,
  isStaffIdentity,
  loadRfqAccess,
  requireProcurement,
  responseLines,
  toResponseDto,
  toRfqDto,
  toRfqItemDto,
  type ResponseLinesJson,
  type ResponseRow,
  type RfqAccess,
  type RfqRow,
  type ServiceOptions,
} from './shared';

/**
 * Requests for quotation: staff create and issue them (the enum's "sent"
 * status), invite supplier users or record manual responses, suppliers
 * respond before the deadline, and the delivered-cost comparison in the
 * domain turns responses into a ranking that never assumes a unit conversion.
 */

async function loadItems(tx: DbExecutor, rfqId: string) {
  return tx
    .select()
    .from(schema.rfqItems)
    .where(eq(schema.rfqItems.rfqId, rfqId))
    .orderBy(asc(schema.rfqItems.sortOrder), asc(schema.rfqItems.id));
}

async function marketName(tx: DbExecutor, marketId: string | null): Promise<string | null> {
  if (!marketId) return null;
  const [m] = await tx
    .select({ name: schema.markets.name })
    .from(schema.markets)
    .where(eq(schema.markets.id, marketId));
  return m?.name ?? null;
}

async function assertLinks(
  tx: DbExecutor,
  input: { organizationId: string; projectId?: string | null; deliveryMarketId?: string | null },
): Promise<void> {
  const [org] = await tx
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.id, input.organizationId));
  if (!org)
    throw new ApiError('validation_failed', 'organisation not found', {
      details: { field: 'organizationId' },
    });
  if (input.projectId) {
    const [project] = await tx
      .select({ organizationId: schema.projects.organizationId })
      .from(schema.projects)
      .where(eq(schema.projects.id, input.projectId));
    if (!project || project.organizationId !== input.organizationId) {
      throw new ApiError('validation_failed', 'project not found in this organisation', {
        details: { field: 'projectId' },
      });
    }
  }
  if (input.deliveryMarketId && (await marketName(tx, input.deliveryMarketId)) === null) {
    throw new ApiError('validation_failed', 'delivery market not found', {
      details: { field: 'deliveryMarketId' },
    });
  }
}

export function toItemSpecs(items: RfqItemDto[]): RfqItemSpec[] {
  return items.map((i) => ({
    itemId: i.id,
    material: i.material,
    specification: i.specification,
    unit: i.unit,
    quantity: i.quantity,
  }));
}

function toResponseInput(row: ResponseRow, items: RfqItemDto[]): ResponseInput {
  const lines = responseLines(row);
  const known = new Set(items.map((i) => i.id));
  return {
    responseId: row.id,
    supplierLabel: row.supplierName ?? row.supplierUserId ?? row.id,
    currency: row.currency,
    deliveryKobo: lines.deliveryKobo,
    lines: lines.lines.filter((l) => known.has(l.itemId)),
    leadTimeDays: lines.leadTimeDays,
    validUntil: row.validUntil ? row.validUntil.toISOString() : null,
  };
}

/** Goods + delivery in the RFQ's units, or null when a line's unit conversion is unknown. */
export function totalDeliveredFor(items: RfqItemDto[], row: ResponseRow): bigint | null {
  const result = compareDeliveredCost(toItemSpecs(items), [toResponseInput(row, items)], {
    currency: row.currency,
  });
  const entry = result.entries[0];
  return entry?.totalDeliveredKobo ? BigInt(entry.totalDeliveredKobo) : null;
}

/* -------------------------------------------------------------------------- */
/* Create and edit                                                            */
/* -------------------------------------------------------------------------- */

export async function createRfq(
  identity: RequestIdentity,
  input: RfqCreate,
  options: ServiceOptions = {},
): Promise<RfqDetail> {
  const userId = requireProcurement(identity);
  assertAllowed(
    authorizeStaff(identity.actor, 'procurement.manage', {
      type: 'rfq',
      organizationId: input.organizationId,
    }),
  );
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    await assertLinks(tx, input);
    const now = await dbNow(tx);
    const reference = await allocateCommercialReference(tx, 'rfqs', 'RFQ', now.date);
    const [rfq] = await tx
      .insert(schema.rfqs)
      .values({
        organizationId: input.organizationId,
        projectId: input.projectId ?? null,
        reference,
        title: input.title,
        status: 'draft',
        deliveryMarketId: input.deliveryMarketId ?? null,
        deliveryAddress: input.deliveryAddress ?? null,
        notes: input.notes ?? null,
        createdBy: userId,
      })
      .returning();
    if (input.items.length > 0) await insertItems(tx, rfq!.id, input.items);
    await recordAudit(tx, identity, {
      action: 'rfq.created',
      entityType: 'rfq',
      entityId: rfq!.id,
      organizationId: input.organizationId,
      after: { reference, title: input.title, items: input.items.length },
      correlationId: options.correlationId,
    });
    return detailInTx(tx, identity, await loadRfqAccess(tx, identity, rfq!.id));
  });
}

async function insertItems(tx: DbExecutor, rfqId: string, items: RfqItemInput[]): Promise<void> {
  await tx.insert(schema.rfqItems).values(
    items.map((item, index) => ({
      rfqId,
      material: item.material,
      specification: item.specification,
      unit: item.unit,
      quantity: item.quantity,
      sortOrder: item.sortOrder ?? index,
    })),
  );
}

async function loadDraft(
  tx: DbExecutor,
  identity: RequestIdentity,
  rfqId: string,
): Promise<RfqAccess> {
  const access = await loadRfqAccess(tx, identity, rfqId, { customer: false });
  if (access.role !== 'staff') throw new ApiError('forbidden', 'staff action');
  if (access.rfq.status !== 'draft') {
    throw new ApiError('invalid_transition', 'only draft RFQs can be edited', {
      details: { status: access.rfq.status },
    });
  }
  return access;
}

export async function updateRfq(
  identity: RequestIdentity,
  rfqId: string,
  input: {
    title?: string;
    projectId?: string | null;
    deliveryMarketId?: string | null;
    deliveryAddress?: Record<string, string> | null;
    notes?: string | null;
  },
  options: ServiceOptions = {},
): Promise<RfqDetail> {
  requireProcurement(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await loadDraft(tx, identity, rfqId);
    await assertLinks(tx, {
      organizationId: access.rfq.organizationId,
      projectId: input.projectId === undefined ? access.rfq.projectId : input.projectId,
      deliveryMarketId:
        input.deliveryMarketId === undefined ? access.rfq.deliveryMarketId : input.deliveryMarketId,
    });
    const patch: Partial<typeof schema.rfqs.$inferInsert> = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.projectId !== undefined) patch.projectId = input.projectId;
    if (input.deliveryMarketId !== undefined) patch.deliveryMarketId = input.deliveryMarketId;
    if (input.deliveryAddress !== undefined) patch.deliveryAddress = input.deliveryAddress;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (Object.keys(patch).length > 0)
      await tx.update(schema.rfqs).set(patch).where(eq(schema.rfqs.id, rfqId));
    await recordAudit(tx, identity, {
      action: 'rfq.updated',
      entityType: 'rfq',
      entityId: rfqId,
      organizationId: access.rfq.organizationId,
      after: patch,
      correlationId: options.correlationId,
    });
    return detailInTx(tx, identity, await loadRfqAccess(tx, identity, rfqId));
  });
}

export async function replaceRfqItems(
  identity: RequestIdentity,
  rfqId: string,
  input: { items: RfqItemInput[] },
  options: ServiceOptions = {},
): Promise<RfqDetail> {
  requireProcurement(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await loadDraft(tx, identity, rfqId);
    await tx.delete(schema.rfqItems).where(eq(schema.rfqItems.rfqId, rfqId));
    await insertItems(tx, rfqId, input.items);
    await recordAudit(tx, identity, {
      action: 'rfq.items_replaced',
      entityType: 'rfq',
      entityId: rfqId,
      organizationId: access.rfq.organizationId,
      after: { items: input.items },
      correlationId: options.correlationId,
    });
    return detailInTx(tx, identity, access);
  });
}

/* -------------------------------------------------------------------------- */
/* Issue, invite, close, cancel                                               */
/* -------------------------------------------------------------------------- */

async function assertPartnerProfiles(tx: DbExecutor, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await tx
    .select({ userId: schema.partnerProfiles.userId })
    .from(schema.partnerProfiles)
    .where(inArray(schema.partnerProfiles.userId, ids));
  const known = new Set(rows.map((r) => r.userId));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length > 0)
    throw new ApiError('validation_failed', 'every supplier must have a partner profile', {
      details: { missing },
    });
}

/** Invitations are draft response rows naming the supplier; that row is what grants the supplier access. */
async function inviteInTx(
  tx: DbExecutor,
  rfq: RfqRow,
  supplierUserIds: string[],
  currency = 'NGN',
): Promise<string[]> {
  const ids = [...new Set(supplierUserIds)];
  await assertPartnerProfiles(tx, ids);
  if (ids.length === 0) return [];
  const existing = await tx
    .select({ supplierUserId: schema.rfqResponses.supplierUserId })
    .from(schema.rfqResponses)
    .where(
      and(eq(schema.rfqResponses.rfqId, rfq.id), inArray(schema.rfqResponses.supplierUserId, ids)),
    );
  const have = new Set(existing.map((e) => e.supplierUserId));
  const fresh = ids.filter((id) => !have.has(id));
  if (fresh.length > 0) {
    const empty: ResponseLinesJson = {
      version: 1,
      deliveryKobo: '0',
      leadTimeDays: null,
      lines: [],
    };
    await tx
      .insert(schema.rfqResponses)
      .values(
        fresh.map((supplierUserId) => ({
          rfqId: rfq.id,
          supplierUserId,
          status: 'draft' as const,
          lines: empty,
          currency,
        })),
      );
  }
  return fresh;
}

export async function issueRfq(
  identity: RequestIdentity,
  rfqId: string,
  input: { deadlineAt: string; supplierUserIds: string[] },
  options: ServiceOptions = {},
): Promise<RfqDetail> {
  const userId = requireProcurement(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await loadDraft(tx, identity, rfqId);
    const items = await loadItems(tx, rfqId);
    if (items.length === 0)
      throw new ApiError('validation_failed', 'add at least one item before issuing the RFQ');
    const now = await dbNow(tx);
    const deadline = new Date(input.deadlineAt);
    if (deadline.getTime() <= now.date.getTime()) {
      throw new ApiError('validation_failed', 'the response deadline must be in the future', {
        details: { serverNow: now.iso },
      });
    }
    await tx
      .update(schema.rfqs)
      .set({ status: 'sent', deadlineAt: deadline })
      .where(eq(schema.rfqs.id, rfqId));
    const invited = await inviteInTx(tx, access.rfq, input.supplierUserIds);
    const recipients = await supplierIds(tx, rfqId);
    await appendOutbox(tx, {
      eventType: 'rfq.issued',
      aggregateType: 'rfq',
      aggregateId: rfqId,
      organizationId: access.rfq.organizationId,
      actorUserId: userId,
      payload: { rfqId, deadlineAt: deadline.toISOString(), recipientUserIds: recipients },
      correlationId: options.correlationId,
    });
    await recordAudit(tx, identity, {
      action: 'rfq.issued',
      entityType: 'rfq',
      entityId: rfqId,
      organizationId: access.rfq.organizationId,
      before: { status: 'draft' },
      after: { status: 'sent', deadlineAt: deadline.toISOString(), invited },
      correlationId: options.correlationId,
    });
    return detailInTx(tx, identity, await loadRfqAccess(tx, identity, rfqId));
  });
}

async function supplierIds(tx: DbExecutor, rfqId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: schema.rfqResponses.supplierUserId })
    .from(schema.rfqResponses)
    .where(eq(schema.rfqResponses.rfqId, rfqId));
  return rows.map((r) => r.id).filter((id): id is string => id !== null);
}

export async function inviteRfqSuppliers(
  identity: RequestIdentity,
  rfqId: string,
  input: { supplierUserIds: string[] },
  options: ServiceOptions = {},
): Promise<RfqDetail> {
  const userId = requireProcurement(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await loadRfqAccess(tx, identity, rfqId, { customer: false });
    if (access.role !== 'staff') throw new ApiError('forbidden', 'staff action');
    if (access.rfq.status !== 'draft' && access.rfq.status !== 'sent') {
      throw new ApiError(
        'invalid_transition',
        'suppliers can only be invited before the RFQ closes',
        { details: { status: access.rfq.status } },
      );
    }
    const invited = await inviteInTx(tx, access.rfq, input.supplierUserIds);
    if (invited.length > 0 && access.rfq.status === 'sent') {
      await appendOutbox(tx, {
        eventType: 'rfq.issued',
        aggregateType: 'rfq',
        aggregateId: rfqId,
        organizationId: access.rfq.organizationId,
        actorUserId: userId,
        payload: {
          rfqId,
          deadlineAt: access.rfq.deadlineAt?.toISOString() ?? null,
          recipientUserIds: invited,
        },
        correlationId: options.correlationId,
      });
    }
    await recordAudit(tx, identity, {
      action: 'rfq.suppliers_invited',
      entityType: 'rfq',
      entityId: rfqId,
      organizationId: access.rfq.organizationId,
      after: { invited },
      correlationId: options.correlationId,
    });
    return detailInTx(tx, identity, access);
  });
}

export async function closeRfq(
  identity: RequestIdentity,
  rfqId: string,
  options: ServiceOptions = {},
): Promise<RfqDetail> {
  requireProcurement(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await loadRfqAccess(tx, identity, rfqId, { customer: false });
    if (access.role !== 'staff') throw new ApiError('forbidden', 'staff action');
    if (access.rfq.status !== 'sent')
      throw new ApiError('invalid_transition', 'only an issued RFQ can be closed', {
        details: { status: access.rfq.status },
      });
    await tx.update(schema.rfqs).set({ status: 'closed' }).where(eq(schema.rfqs.id, rfqId));
    await recordAudit(tx, identity, {
      action: 'rfq.closed',
      entityType: 'rfq',
      entityId: rfqId,
      organizationId: access.rfq.organizationId,
      before: { status: 'sent' },
      after: { status: 'closed' },
      correlationId: options.correlationId,
    });
    return detailInTx(tx, identity, await loadRfqAccess(tx, identity, rfqId));
  });
}

export async function cancelRfq(
  identity: RequestIdentity,
  rfqId: string,
  input: { reason: string },
  options: ServiceOptions = {},
): Promise<RfqDetail> {
  requireProcurement(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await loadRfqAccess(tx, identity, rfqId, { customer: false });
    if (access.role !== 'staff') throw new ApiError('forbidden', 'staff action');
    if (access.rfq.status === 'cancelled' || access.rfq.status === 'awarded') {
      throw new ApiError('invalid_transition', `a ${access.rfq.status} RFQ cannot be cancelled`);
    }
    await tx.update(schema.rfqs).set({ status: 'cancelled' }).where(eq(schema.rfqs.id, rfqId));
    await recordAudit(tx, identity, {
      action: 'rfq.cancelled',
      entityType: 'rfq',
      entityId: rfqId,
      organizationId: access.rfq.organizationId,
      before: { status: access.rfq.status },
      after: { status: 'cancelled' },
      reason: input.reason,
      correlationId: options.correlationId,
    });
    return detailInTx(tx, identity, await loadRfqAccess(tx, identity, rfqId));
  });
}

/* -------------------------------------------------------------------------- */
/* Responses                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Records a response. Suppliers update the response row that invited them
 * (before the deadline on the database clock); staff record a manual
 * response (supplierName, no account) or one on behalf of an invited
 * supplier user. Line item ids must belong to the RFQ.
 */
export async function submitRfqResponse(
  identity: RequestIdentity,
  rfqId: string,
  input: RfqResponseSubmit,
  options: ServiceOptions = {},
): Promise<RfqResponseDto> {
  const userId = requireProcurement(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await loadRfqAccess(tx, identity, rfqId, { customer: false });
    const { rfq } = access;
    if (rfq.status !== 'sent')
      throw new ApiError('invalid_transition', 'the RFQ is not open for responses', {
        details: { status: rfq.status },
      });
    const items = (await loadItems(tx, rfqId)).map(toRfqItemDto);
    const itemIds = new Set(items.map((i) => i.id));
    const seen = new Set<string>();
    for (const line of input.lines) {
      if (!itemIds.has(line.itemId))
        throw new ApiError('validation_failed', 'line item does not belong to this RFQ', {
          details: { itemId: line.itemId },
        });
      if (seen.has(line.itemId))
        throw new ApiError('validation_failed', 'duplicate line for an item', {
          details: { itemId: line.itemId },
        });
      seen.add(line.itemId);
    }
    let target: ResponseRow | null = null;
    if (access.role === 'supplier') {
      if (input.supplierUserId || input.supplierName) {
        throw new ApiError('validation_failed', 'suppliers respond for themselves only');
      }
      target = access.ownResponse;
      const now = await dbNow(tx);
      if (rfq.deadlineAt && rfq.deadlineAt.getTime() <= now.date.getTime()) {
        throw new ApiError('deadline_passed', 'the response deadline has passed', {
          details: { deadlineAt: rfq.deadlineAt.toISOString(), serverNow: now.iso },
        });
      }
    } else if (input.supplierUserId) {
      await assertPartnerProfiles(tx, [input.supplierUserId]);
      const [row] = await tx
        .select()
        .from(schema.rfqResponses)
        .where(
          and(
            eq(schema.rfqResponses.rfqId, rfqId),
            eq(schema.rfqResponses.supplierUserId, input.supplierUserId),
          ),
        );
      target = row ?? null;
    } else if (!input.supplierName) {
      throw new ApiError(
        'validation_failed',
        'a manual response needs supplierName or supplierUserId',
      );
    }
    if (target && target.status !== 'draft' && target.status !== 'submitted') {
      throw new ApiError('invalid_transition', `a ${target.status} response cannot be changed`);
    }
    if (input.supplierFacilityId) {
      const [facility] = await tx
        .select({ id: schema.supplyFacilities.id })
        .from(schema.supplyFacilities)
        .where(eq(schema.supplyFacilities.id, input.supplierFacilityId));
      if (!facility)
        throw new ApiError('validation_failed', 'supplier facility not found', {
          details: { field: 'supplierFacilityId' },
        });
    }
    const lines: ResponseLinesJson = {
      version: 1,
      deliveryKobo: input.deliveryKobo,
      leadTimeDays: input.leadTimeDays ?? null,
      lines: input.lines.map((l) => ({
        itemId: l.itemId,
        unitPriceKobo: l.unitPriceKobo,
        quantityUnit: l.quantityUnit,
        declaredConversion: l.declaredConversion ?? null,
        leadTimeDays: l.leadTimeDays ?? null,
        note: l.note ?? null,
      })),
    };
    const now = await dbNow(tx);
    const values = {
      supplierName: input.supplierName ?? target?.supplierName ?? null,
      supplierFacilityId:
        input.supplierFacilityId === undefined
          ? (target?.supplierFacilityId ?? null)
          : input.supplierFacilityId,
      status: input.submit ? ('submitted' as const) : ('draft' as const),
      lines,
      currency: input.currency,
      validUntil: input.validUntil ? new Date(input.validUntil) : null,
      submittedAt: input.submit ? now.date : null,
    };
    let saved: ResponseRow;
    if (target) {
      const [row] = await tx
        .update(schema.rfqResponses)
        .set(values)
        .where(eq(schema.rfqResponses.id, target.id))
        .returning();
      saved = row!;
    } else {
      const [row] = await tx
        .insert(schema.rfqResponses)
        .values({ rfqId, supplierUserId: input.supplierUserId ?? null, ...values })
        .returning();
      saved = row!;
    }
    const total = totalDeliveredFor(items, saved);
    const [withTotal] = await tx
      .update(schema.rfqResponses)
      .set({ totalDeliveredKobo: total })
      .where(eq(schema.rfqResponses.id, saved.id))
      .returning();
    if (input.submit) {
      await appendOutbox(tx, {
        eventType: 'rfq.response.submitted',
        aggregateType: 'rfq',
        aggregateId: rfqId,
        organizationId: rfq.organizationId,
        actorUserId: userId,
        payload: { rfqId, responseId: saved.id },
        correlationId: options.correlationId,
      });
    }
    await recordAudit(tx, identity, {
      action: input.submit ? 'rfq.response.submitted' : 'rfq.response.saved',
      entityType: 'rfq_response',
      entityId: saved.id,
      organizationId: rfq.organizationId,
      after: {
        rfqId,
        lines: lines.lines.length,
        deliveryKobo: input.deliveryKobo,
        totalDeliveredKobo: total?.toString() ?? null,
        onBehalfOf: input.supplierUserId ?? input.supplierName ?? null,
      },
      correlationId: options.correlationId,
    });
    return toResponseDto(withTotal!);
  });
}

export async function withdrawRfqResponse(
  identity: RequestIdentity,
  rfqId: string,
  responseId: string,
  options: ServiceOptions = {},
): Promise<RfqResponseDto> {
  requireProcurement(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await loadRfqAccess(tx, identity, rfqId, { customer: false });
    const [row] = await tx
      .select()
      .from(schema.rfqResponses)
      .where(and(eq(schema.rfqResponses.id, responseId), eq(schema.rfqResponses.rfqId, rfqId)));
    if (!row || (access.role === 'supplier' && row.id !== access.ownResponse?.id))
      throw new ApiError('not_found', 'response not found');
    if (row.status !== 'draft' && row.status !== 'submitted')
      throw new ApiError('invalid_transition', `a ${row.status} response cannot be withdrawn`);
    const [updated] = await tx
      .update(schema.rfqResponses)
      .set({ status: 'withdrawn' })
      .where(eq(schema.rfqResponses.id, responseId))
      .returning();
    await recordAudit(tx, identity, {
      action: 'rfq.response.withdrawn',
      entityType: 'rfq_response',
      entityId: responseId,
      organizationId: access.rfq.organizationId,
      before: { status: row.status },
      after: { status: 'withdrawn' },
      correlationId: options.correlationId,
    });
    return toResponseDto(updated!);
  });
}

/* -------------------------------------------------------------------------- */
/* Read models                                                                */
/* -------------------------------------------------------------------------- */

async function detailInTx(
  tx: Transaction | DbExecutor,
  identity: RequestIdentity,
  access: RfqAccess,
): Promise<RfqDetail> {
  const { rfq } = access;
  const items = await loadItems(tx, rfq.id);
  const responses =
    access.role === 'supplier'
      ? access.ownResponse
        ? [access.ownResponse]
        : []
      : await tx
          .select()
          .from(schema.rfqResponses)
          .where(eq(schema.rfqResponses.rfqId, rfq.id))
          .orderBy(asc(schema.rfqResponses.createdAt));
  return {
    ...toRfqDto(rfq, await marketName(tx, rfq.deliveryMarketId)),
    items: items.map(toRfqItemDto),
    responses: responses.map(toResponseDto),
  };
}

export async function getRfq(
  identity: RequestIdentity,
  rfqId: string,
  options: ServiceOptions = {},
): Promise<RfqDetail> {
  requireProcurement(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) =>
    detailInTx(tx, identity, await loadRfqAccess(tx, identity, rfqId)),
  );
}

/** Staff list every RFQ; customers their organisation's; suppliers the RFQs whose response rows name them. */
export async function listRfqs(
  identity: RequestIdentity,
  query: RfqListQuery,
  options: ServiceOptions = {},
): Promise<Page<RfqDto>> {
  const userId = requireProcurement(identity);
  const cursor = decodeCursor(query.cursor);
  let organizationId = query.organizationId ?? null;
  let supplierOnly = false;
  if (isStaffIdentity(identity)) {
    assertAllowed(authorizeStaff(identity.actor, 'procurement.manage'));
  } else if (identity.actor.isPartner && !identity.ctx.organizationId) {
    supplierOnly = true;
  } else {
    organizationId = identity.ctx.organizationId;
    if (!organizationId) return { items: [], nextCursor: null };
    assertAllowed(authorizeOrg(identity.actor, 'org.read', { type: 'rfq', organizationId }));
  }
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const supplierRfqIds = supplierOnly
      ? (
          await tx
            .select({ rfqId: schema.rfqResponses.rfqId })
            .from(schema.rfqResponses)
            .where(eq(schema.rfqResponses.supplierUserId, userId))
        ).map((r) => r.rfqId)
      : null;
    if (supplierRfqIds && supplierRfqIds.length === 0) return { items: [], nextCursor: null };
    const rows = await tx
      .select({ rfq: schema.rfqs, marketName: schema.markets.name })
      .from(schema.rfqs)
      .leftJoin(schema.markets, eq(schema.markets.id, schema.rfqs.deliveryMarketId))
      .where(
        and(
          organizationId ? eq(schema.rfqs.organizationId, organizationId) : undefined,
          supplierRfqIds ? inArray(schema.rfqs.id, supplierRfqIds) : undefined,
          query.status ? eq(schema.rfqs.status, query.status) : undefined,
          query.projectId ? eq(schema.rfqs.projectId, query.projectId) : undefined,
          cursor
            ? or(
                lt(schema.rfqs.createdAt, cursor.createdAt),
                and(eq(schema.rfqs.createdAt, cursor.createdAt), lt(schema.rfqs.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.rfqs.createdAt), desc(schema.rfqs.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = rows.length > query.limit ? page[page.length - 1] : null;
    return {
      items: page.map((r) => toRfqDto(r.rfq, r.marketName)),
      nextCursor: last ? encodeCursor(last.rfq.createdAt, last.rfq.id) : null,
    };
  });
}

/** Delivered-cost comparison across submitted responses (staff and customers). */
export async function getRfqComparison(
  identity: RequestIdentity,
  rfqId: string,
  options: ServiceOptions = {},
): Promise<RfqComparisonDto> {
  requireProcurement(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await loadRfqAccess(tx, identity, rfqId);
    if (access.role === 'supplier')
      throw new ApiError('forbidden', 'suppliers do not see competing responses');
    const items = (await loadItems(tx, rfqId)).map(toRfqItemDto);
    const responses = await tx
      .select()
      .from(schema.rfqResponses)
      .where(
        and(
          eq(schema.rfqResponses.rfqId, rfqId),
          inArray(schema.rfqResponses.status, ['submitted', 'selected']),
        ),
      )
      .orderBy(asc(schema.rfqResponses.submittedAt));
    const result = compareDeliveredCost(
      toItemSpecs(items),
      responses.map((r) => toResponseInput(r, items)),
      { currency: 'NGN' },
    );
    return {
      rfqId,
      currency: result.currency,
      items,
      entries: result.entries,
      ranked: result.ranked,
      note: result.note,
    };
  });
}
