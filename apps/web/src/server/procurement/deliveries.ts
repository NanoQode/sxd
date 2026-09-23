import 'server-only';
import { and, asc, desc, eq, inArray, lt, or } from 'drizzle-orm';
import {
  ApiError,
  type DeliveryDto,
  type DeliveryListQuery,
  type DeliveryRecord,
  type DiscrepancyCreate,
  type DiscrepancyDto,
  type DiscrepancyTransition,
  type Page,
} from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor, type DbExecutor } from '@simplexd/db';
import { deliveryVariance, purchaseOrderStatusAfterDelivery } from '@simplexd/domain/procurement';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { decodeCursor, encodeCursor } from '@/server/portal/elevate';
import { dbNow } from '@/server/tenders/shared';
import {
  ctxFor,
  deliveryLines,
  isStaffIdentity,
  loadPurchaseOrderAccess,
  purchaseOrderLines,
  requireProcurement,
  toDeliveryDto,
  toDiscrepancyDto,
  type DeliveryLinesJson,
  type DeliveryRow,
  type PurchaseOrderRow,
  type ServiceOptions,
} from './shared';

/**
 * Deliveries against a purchase order (received quantities per line with
 * evidence files) and discrepancies (short delivery, damaged, wrong spec)
 * with the flow open → supplier_notified → resolved | credited | returned.
 */

const RECEIVABLE: ReadonlySet<PurchaseOrderRow['status']> = new Set([
  'issued',
  'acknowledged',
  'partially_delivered',
]);

async function loadDelivery(
  tx: DbExecutor,
  identity: RequestIdentity,
  deliveryId: string,
  staffOnly: boolean,
) {
  const [delivery] = await tx
    .select()
    .from(schema.deliveries)
    .where(eq(schema.deliveries.id, deliveryId));
  if (!delivery) throw new ApiError('not_found', 'delivery not found');
  const access = await loadPurchaseOrderAccess(
    tx,
    identity,
    delivery.purchaseOrderId,
    staffOnly ? { customer: false } : {},
  );
  if (staffOnly && access.role !== 'staff') throw new ApiError('forbidden', 'staff action');
  return { delivery, ...access };
}

async function dtoInTx(
  tx: DbExecutor,
  delivery: DeliveryRow,
  poNumber: string,
): Promise<DeliveryDto> {
  const discrepancies = await tx
    .select()
    .from(schema.discrepancies)
    .where(eq(schema.discrepancies.deliveryId, delivery.id))
    .orderBy(asc(schema.discrepancies.createdAt));
  return toDeliveryDto(delivery, poNumber, discrepancies);
}

async function refreshPurchaseOrderStatus(tx: DbExecutor, po: PurchaseOrderRow): Promise<void> {
  const deliveries = await tx
    .select()
    .from(schema.deliveries)
    .where(eq(schema.deliveries.purchaseOrderId, po.id));
  const ordered = purchaseOrderLines(po).lines.map((l) => ({
    lineId: l.lineId,
    quantity: l.quantity,
  }));
  const received = deliveries.flatMap((d) =>
    deliveryLines(d).map((l) => ({ lineId: l.lineId, quantityReceived: l.quantityReceived })),
  );
  const next = purchaseOrderStatusAfterDelivery(deliveryVariance(ordered, received).status);
  if (next && next !== po.status && RECEIVABLE.has(po.status)) {
    await tx
      .update(schema.purchaseOrders)
      .set({ status: next, version: po.version + 1 })
      .where(eq(schema.purchaseOrders.id, po.id));
  }
}

export async function recordDelivery(
  identity: RequestIdentity,
  poId: string,
  input: DeliveryRecord,
  options: ServiceOptions = {},
): Promise<DeliveryDto> {
  const userId = requireProcurement(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { po, role } = await loadPurchaseOrderAccess(tx, identity, poId, { customer: false });
    if (role !== 'staff') throw new ApiError('forbidden', 'staff action');
    if (!RECEIVABLE.has(po.status))
      throw new ApiError(
        'invalid_transition',
        `deliveries cannot be recorded against a ${po.status} purchase order`,
      );
    const lineIds = new Set(purchaseOrderLines(po).lines.map((l) => l.lineId));
    for (const line of input.lines) {
      if (!lineIds.has(line.lineId))
        throw new ApiError('validation_failed', 'unknown purchase order line', {
          details: { lineId: line.lineId },
        });
    }
    if (input.evidenceFileIds.length > 0) {
      const files = await tx
        .select({ id: schema.fileObjects.id })
        .from(schema.fileObjects)
        .where(
          and(
            inArray(schema.fileObjects.id, input.evidenceFileIds),
            eq(schema.fileObjects.organizationId, po.organizationId),
          ),
        );
      if (files.length !== new Set(input.evidenceFileIds).size) {
        throw new ApiError(
          'validation_failed',
          'evidence files must belong to the ordering organisation',
          { details: { field: 'evidenceFileIds' } },
        );
      }
    }
    const receivedBy = input.receivedByUserId ?? userId;
    const [user] = await tx
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.id, receivedBy));
    if (!user)
      throw new ApiError('validation_failed', 'receiving user not found', {
        details: { field: 'receivedByUserId' },
      });
    const lines: DeliveryLinesJson = input.lines.map((l) => ({
      lineId: l.lineId,
      quantityReceived: l.quantityReceived,
      note: l.note ?? null,
      discrepancyIds: [],
    }));
    const [delivery] = await tx
      .insert(schema.deliveries)
      .values({
        purchaseOrderId: poId,
        deliveredAt: new Date(input.deliveredAt),
        receivedByUserId: receivedBy,
        lines,
        evidenceFileIds: input.evidenceFileIds,
        status: 'received',
        note: input.note ?? null,
      })
      .returning();
    await refreshPurchaseOrderStatus(tx, po);
    await appendOutbox(tx, {
      eventType: 'delivery.recorded',
      aggregateType: 'purchase_order',
      aggregateId: poId,
      organizationId: po.organizationId,
      actorUserId: userId,
      payload: {
        purchaseOrderId: poId,
        deliveryId: delivery!.id,
        recipientUserIds: po.supplierUserId ? [po.supplierUserId] : [],
      },
      correlationId: options.correlationId,
    });
    await recordAudit(tx, identity, {
      action: 'delivery.recorded',
      entityType: 'delivery',
      entityId: delivery!.id,
      organizationId: po.organizationId,
      after: { purchaseOrderId: poId, lines, evidenceFileIds: input.evidenceFileIds },
      correlationId: options.correlationId,
    });
    return dtoInTx(tx, delivery!, po.number);
  });
}

export async function acceptDelivery(
  identity: RequestIdentity,
  deliveryId: string,
  options: ServiceOptions = {},
): Promise<DeliveryDto> {
  requireProcurement(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { delivery, po } = await loadDelivery(tx, identity, deliveryId, true);
    if (delivery.status !== 'received' && delivery.status !== 'disputed')
      throw new ApiError('invalid_transition', `a ${delivery.status} delivery cannot be accepted`);
    const open = await tx
      .select({ id: schema.discrepancies.id })
      .from(schema.discrepancies)
      .where(
        and(
          eq(schema.discrepancies.deliveryId, deliveryId),
          inArray(schema.discrepancies.status, ['open', 'supplier_notified']),
        ),
      );
    if (open.length > 0)
      throw new ApiError(
        'invalid_transition',
        'resolve open discrepancies before accepting the delivery',
        { details: { openDiscrepancyIds: open.map((o) => o.id) } },
      );
    const [updated] = await tx
      .update(schema.deliveries)
      .set({ status: 'accepted' })
      .where(eq(schema.deliveries.id, deliveryId))
      .returning();
    await recordAudit(tx, identity, {
      action: 'delivery.accepted',
      entityType: 'delivery',
      entityId: deliveryId,
      organizationId: po.organizationId,
      before: { status: delivery.status },
      after: { status: 'accepted' },
      correlationId: options.correlationId,
    });
    return dtoInTx(tx, updated!, po.number);
  });
}

export async function openDiscrepancy(
  identity: RequestIdentity,
  deliveryId: string,
  input: DiscrepancyCreate,
  options: ServiceOptions = {},
): Promise<DiscrepancyDto> {
  const userId = requireProcurement(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { delivery, po } = await loadDelivery(tx, identity, deliveryId, true);
    if (delivery.status !== 'received' && delivery.status !== 'disputed')
      throw new ApiError('invalid_transition', `a ${delivery.status} delivery cannot be disputed`);
    const lines = deliveryLines(delivery);
    if (input.lineId && !lines.some((l) => l.lineId === input.lineId)) {
      throw new ApiError('validation_failed', 'unknown delivery line', {
        details: { lineId: input.lineId },
      });
    }
    const [row] = await tx
      .insert(schema.discrepancies)
      .values({
        deliveryId,
        kind: input.kind,
        description: input.description,
        quantity: input.quantity ?? null,
        status: 'open',
        createdBy: userId,
      })
      .returning();
    const updatedLines = input.lineId
      ? lines.map((l) =>
          l.lineId === input.lineId ? { ...l, discrepancyIds: [...l.discrepancyIds, row!.id] } : l,
        )
      : lines;
    await tx
      .update(schema.deliveries)
      .set({ status: 'disputed', lines: updatedLines })
      .where(eq(schema.deliveries.id, deliveryId));
    await appendOutbox(tx, {
      eventType: 'delivery.discrepancy.opened',
      aggregateType: 'delivery',
      aggregateId: deliveryId,
      organizationId: po.organizationId,
      actorUserId: userId,
      payload: {
        purchaseOrderId: po.id,
        deliveryId,
        discrepancyId: row!.id,
        recipientUserIds: po.supplierUserId ? [po.supplierUserId] : [],
      },
      correlationId: options.correlationId,
    });
    await recordAudit(tx, identity, {
      action: 'delivery.discrepancy_opened',
      entityType: 'discrepancy',
      entityId: row!.id,
      organizationId: po.organizationId,
      after: {
        deliveryId,
        kind: input.kind,
        quantity: input.quantity ?? null,
        lineId: input.lineId ?? null,
      },
      correlationId: options.correlationId,
    });
    return toDiscrepancyDto(row!, input.lineId ?? null);
  });
}

const DISCREPANCY_FLOW: Record<string, ReadonlySet<string>> = {
  open: new Set(['supplier_notified']),
  supplier_notified: new Set(['resolved', 'credited', 'returned']),
};

export async function transitionDiscrepancy(
  identity: RequestIdentity,
  deliveryId: string,
  discrepancyId: string,
  input: DiscrepancyTransition,
  options: ServiceOptions = {},
): Promise<DiscrepancyDto> {
  requireProcurement(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { delivery, po } = await loadDelivery(tx, identity, deliveryId, true);
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
    if (!DISCREPANCY_FLOW[row.status]?.has(input.to)) {
      throw new ApiError(
        'invalid_transition',
        `a discrepancy cannot move from ${row.status} to ${input.to}`,
        { details: { from: row.status, to: input.to } },
      );
    }
    const closing = input.to !== 'supplier_notified';
    const now = await dbNow(tx);
    const [updated] = await tx
      .update(schema.discrepancies)
      .set({
        status: input.to,
        resolution: input.resolution ?? row.resolution,
        resolvedAt: closing ? now.date : null,
      })
      .where(eq(schema.discrepancies.id, discrepancyId))
      .returning();
    if (input.to === 'supplier_notified') {
      await appendOutbox(tx, {
        eventType: 'delivery.discrepancy.supplier_notified',
        aggregateType: 'delivery',
        aggregateId: deliveryId,
        organizationId: po.organizationId,
        actorUserId: identity.session!.user.id,
        payload: {
          deliveryId,
          discrepancyId,
          recipientUserIds: po.supplierUserId ? [po.supplierUserId] : [],
        },
        correlationId: options.correlationId,
      });
    }
    await recordAudit(tx, identity, {
      action: `delivery.discrepancy_${input.to}`,
      entityType: 'discrepancy',
      entityId: discrepancyId,
      organizationId: po.organizationId,
      before: { status: row.status },
      after: { status: input.to, resolution: updated!.resolution },
      correlationId: options.correlationId,
    });
    const lineOf =
      deliveryLines(delivery).find((l) => l.discrepancyIds.includes(discrepancyId))?.lineId ?? null;
    return toDiscrepancyDto(updated!, lineOf);
  });
}

export async function getDelivery(
  identity: RequestIdentity,
  deliveryId: string,
  options: ServiceOptions = {},
): Promise<DeliveryDto> {
  requireProcurement(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { delivery, po } = await loadDelivery(tx, identity, deliveryId, false);
    return dtoInTx(tx, delivery, po.number);
  });
}

/** Deliveries the caller may see: staff all, customers their organisation's orders, vendors orders naming them. */
export async function listDeliveries(
  identity: RequestIdentity,
  query: DeliveryListQuery,
  options: ServiceOptions = {},
): Promise<Page<DeliveryDto>> {
  const userId = requireProcurement(identity);
  const cursor = decodeCursor(query.cursor);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    if (query.purchaseOrderId) await loadPurchaseOrderAccess(tx, identity, query.purchaseOrderId);
    const staff = isStaffIdentity(identity);
    const supplierScoped = !staff && identity.actor.isPartner && !identity.ctx.organizationId;
    const rows = await tx
      .select({ delivery: schema.deliveries, po: schema.purchaseOrders })
      .from(schema.deliveries)
      .innerJoin(
        schema.purchaseOrders,
        eq(schema.purchaseOrders.id, schema.deliveries.purchaseOrderId),
      )
      .where(
        and(
          query.purchaseOrderId
            ? eq(schema.deliveries.purchaseOrderId, query.purchaseOrderId)
            : undefined,
          query.status ? eq(schema.deliveries.status, query.status) : undefined,
          supplierScoped ? eq(schema.purchaseOrders.supplierUserId, userId) : undefined,
          !staff && !supplierScoped && identity.ctx.organizationId
            ? eq(schema.purchaseOrders.organizationId, identity.ctx.organizationId)
            : undefined,
          cursor
            ? or(
                lt(schema.deliveries.createdAt, cursor.createdAt),
                and(
                  eq(schema.deliveries.createdAt, cursor.createdAt),
                  lt(schema.deliveries.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.deliveries.createdAt), desc(schema.deliveries.id))
      .limit(query.limit + 1);
    if (!staff && !supplierScoped && !identity.ctx.organizationId)
      return { items: [], nextCursor: null };
    const page = rows.slice(0, query.limit);
    const ids = page.map((r) => r.delivery.id);
    const discrepancies = ids.length
      ? await tx
          .select()
          .from(schema.discrepancies)
          .where(inArray(schema.discrepancies.deliveryId, ids))
          .orderBy(asc(schema.discrepancies.createdAt))
      : [];
    const items = page.map((r) =>
      toDeliveryDto(
        r.delivery,
        r.po.number,
        discrepancies.filter((d) => d.deliveryId === r.delivery.id),
      ),
    );
    const last = rows.length > query.limit ? page[page.length - 1] : null;
    return {
      items,
      nextCursor: last ? encodeCursor(last.delivery.createdAt, last.delivery.id) : null,
    };
  });
}
