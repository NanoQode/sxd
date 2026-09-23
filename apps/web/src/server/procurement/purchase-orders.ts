import 'server-only';
import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import {
  ApiError,
  type Page,
  type PurchaseOrderCreate,
  type PurchaseOrderDetail,
  type PurchaseOrderDto,
  type PurchaseOrderLineDto,
  type PurchaseOrderListQuery,
} from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor, type DbExecutor } from '@simplexd/db';
import { assertAllowed, authorizeOrg, authorizeStaff } from '@simplexd/domain/authz';
import { compareDeliveredCost, deliveryVariance } from '@simplexd/domain/procurement';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { decodeCursor, encodeCursor } from '@/server/portal/elevate';
import { allocateCommercialReference, dbNow } from '@/server/tenders/shared';
import { toItemSpecs } from './rfqs';
import {
  assertVersion,
  ctxFor,
  deliveryLines,
  isStaffIdentity,
  loadPurchaseOrderAccess,
  loadRfqAccess,
  purchaseOrderLines,
  requireProcurement,
  responseLines,
  toPurchaseOrderDto,
  toRfqItemDto,
  type PurchaseOrderLinesJson,
  type PurchaseOrderRow,
  type ServiceOptions,
} from './shared';
import { recordSupplierQuotesFromAward } from './supplier-quotes';

/**
 * Purchase orders: created from a submitted response (lines copied, totals
 * computed server-side through the domain comparison so no unit conversion
 * is ever assumed), issued idempotently, acknowledged by the supplier and
 * cancelled with a reason. Vendors only ever see orders naming them.
 */

export async function createPurchaseOrder(
  identity: RequestIdentity,
  input: PurchaseOrderCreate,
  options: ServiceOptions = {},
): Promise<PurchaseOrderDetail> {
  const userId = requireProcurement(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const [response] = await tx
      .select()
      .from(schema.rfqResponses)
      .where(eq(schema.rfqResponses.id, input.responseId));
    if (!response) throw new ApiError('not_found', 'response not found');
    const access = await loadRfqAccess(tx, identity, response.rfqId, { customer: false });
    if (access.role !== 'staff') throw new ApiError('forbidden', 'staff action');
    const { rfq } = access;
    if (response.status !== 'submitted' && response.status !== 'selected') {
      throw new ApiError(
        'invalid_transition',
        `a ${response.status} response cannot become a purchase order`,
      );
    }
    if (rfq.status !== 'sent' && rfq.status !== 'closed' && rfq.status !== 'awarded') {
      throw new ApiError('invalid_transition', `the RFQ is ${rfq.status}`);
    }
    const items = (
      await tx
        .select()
        .from(schema.rfqItems)
        .where(eq(schema.rfqItems.rfqId, rfq.id))
        .orderBy(asc(schema.rfqItems.sortOrder))
    ).map(toRfqItemDto);
    const stored = responseLines(response);
    const overrides = new Map(input.lineConversions.map((c) => [c.itemId, c.declaredConversion]));
    const lines = stored.lines.map((l) => ({
      ...l,
      declaredConversion: overrides.get(l.itemId) ?? l.declaredConversion ?? null,
    }));
    const comparison = compareDeliveredCost(
      toItemSpecs(items),
      [
        {
          responseId: response.id,
          supplierLabel: response.supplierName ?? response.supplierUserId ?? response.id,
          currency: response.currency,
          deliveryKobo: stored.deliveryKobo,
          lines,
        },
      ],
      { currency: response.currency },
    );
    const entry = comparison.entries[0]!;
    if (!entry.fullyComparable || entry.goodsKobo === null || entry.deliveryKobo === null) {
      throw new ApiError(
        'validation_failed',
        'every line needs a known quantity conversion before ordering; declare a staff-measured factor for the unknown lines',
        {
          details: { unknowns: entry.unknowns },
        },
      );
    }
    const byItem = new Map(lines.map((l) => [l.itemId, l]));
    const poLines: PurchaseOrderLineDto[] = entry.lines.map((cl, index) => {
      const item = items.find((i) => i.id === cl.itemId)!;
      const src = byItem.get(cl.itemId)!;
      return {
        lineId: `L${index + 1}`,
        itemId: item.id,
        material: item.material,
        specification: item.specification,
        unit: item.unit,
        quantity: item.quantity,
        supplierUnit: src.quantityUnit,
        unitPriceKobo: src.unitPriceKobo,
        conversion: src.declaredConversion ?? null,
        lineTotalKobo: cl.lineTotalKobo as string,
      };
    });
    const linesJson: PurchaseOrderLinesJson = {
      version: 1,
      deliveryKobo: entry.deliveryKobo,
      lines: poLines,
    };
    const now = await dbNow(tx);
    const number = await allocateCommercialReference(tx, 'purchase_orders', 'PO', now.date);
    const total = BigInt(entry.goodsKobo) + BigInt(entry.deliveryKobo);
    const [po] = await tx
      .insert(schema.purchaseOrders)
      .values({
        organizationId: rfq.organizationId,
        projectId: input.projectId === undefined ? rfq.projectId : input.projectId,
        rfqId: rfq.id,
        responseId: response.id,
        number,
        status: 'draft',
        supplierUserId: response.supplierUserId,
        supplierName: response.supplierName,
        supplierRef: input.supplierRef ?? null,
        lines: linesJson,
        totalKobo: total,
        currency: response.currency,
        expectedDeliveryAt: input.expectedDeliveryAt ? new Date(input.expectedDeliveryAt) : null,
        createdBy: userId,
      })
      .returning();
    await recordAudit(tx, identity, {
      action: 'purchase_order.created',
      entityType: 'purchase_order',
      entityId: po!.id,
      organizationId: rfq.organizationId,
      after: {
        number,
        responseId: response.id,
        totalKobo: total.toString(),
        lines: poLines.length,
      },
      correlationId: options.correlationId,
    });
    return detailInTx(tx, po!);
  });
}

async function detailInTx(tx: DbExecutor, po: PurchaseOrderRow): Promise<PurchaseOrderDetail> {
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
  const variance = deliveryVariance(ordered, received);
  return { ...toPurchaseOrderDto(po), deliveryProgress: variance };
}

export async function issuePurchaseOrder(
  identity: RequestIdentity,
  poId: string,
  input: { expectedVersion?: number },
  options: ServiceOptions = {},
): Promise<PurchaseOrderDetail> {
  const userId = requireProcurement(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { po, role } = await loadPurchaseOrderAccess(tx, identity, poId, { customer: false });
    if (role !== 'staff') throw new ApiError('forbidden', 'staff action');
    assertVersion(po.version, input.expectedVersion);
    if (po.status !== 'draft')
      throw new ApiError('invalid_transition', `a ${po.status} purchase order cannot be issued`);
    const now = await dbNow(tx);
    const [updated] = await tx
      .update(schema.purchaseOrders)
      .set({ status: 'issued', issuedAt: now.date, version: po.version + 1 })
      .where(and(eq(schema.purchaseOrders.id, poId), eq(schema.purchaseOrders.version, po.version)))
      .returning();
    if (!updated) throw new ApiError('version_conflict', 'purchase order changed concurrently');
    if (po.responseId)
      await tx
        .update(schema.rfqResponses)
        .set({ status: 'selected' })
        .where(eq(schema.rfqResponses.id, po.responseId));
    if (po.rfqId)
      await tx
        .update(schema.rfqs)
        .set({ status: 'awarded' })
        .where(and(eq(schema.rfqs.id, po.rfqId), inArray(schema.rfqs.status, ['sent', 'closed'])));
    // The accepted response is now a real, dated supplier quotation for the delivery market.
    const supplierQuoteIds = await recordSupplierQuotesFromAward(tx, identity, updated, options);
    await appendOutbox(tx, {
      eventType: 'purchase_order.issued',
      aggregateType: 'purchase_order',
      aggregateId: poId,
      organizationId: po.organizationId,
      actorUserId: userId,
      payload: {
        purchaseOrderId: poId,
        rfqId: po.rfqId,
        recipientUserIds: po.supplierUserId ? [po.supplierUserId] : [],
      },
      correlationId: options.correlationId,
    });
    await recordAudit(tx, identity, {
      action: 'purchase_order.issued',
      entityType: 'purchase_order',
      entityId: poId,
      organizationId: po.organizationId,
      before: { status: 'draft' },
      after: { status: 'issued', issuedAt: now.iso, supplierQuoteIds },
      correlationId: options.correlationId,
    });
    return detailInTx(tx, updated);
  });
}

export async function acknowledgePurchaseOrder(
  identity: RequestIdentity,
  poId: string,
  input: {
    supplierRef?: string | null;
    expectedDeliveryAt?: string | null;
    expectedVersion?: number;
  },
  options: ServiceOptions = {},
): Promise<PurchaseOrderDetail> {
  requireProcurement(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { po, role } = await loadPurchaseOrderAccess(tx, identity, poId, {
      supplier: 'partner.rfqs.respond',
      customer: false,
    });
    if (role !== 'supplier' && role !== 'staff')
      throw new ApiError('forbidden', 'only the supplier acknowledges');
    assertVersion(po.version, input.expectedVersion);
    if (po.status !== 'issued')
      throw new ApiError(
        'invalid_transition',
        `a ${po.status} purchase order cannot be acknowledged`,
      );
    const [updated] = await tx
      .update(schema.purchaseOrders)
      .set({
        status: 'acknowledged',
        supplierRef: input.supplierRef === undefined ? po.supplierRef : input.supplierRef,
        expectedDeliveryAt:
          input.expectedDeliveryAt === undefined
            ? po.expectedDeliveryAt
            : input.expectedDeliveryAt
              ? new Date(input.expectedDeliveryAt)
              : null,
        version: po.version + 1,
      })
      .where(and(eq(schema.purchaseOrders.id, poId), eq(schema.purchaseOrders.version, po.version)))
      .returning();
    if (!updated) throw new ApiError('version_conflict', 'purchase order changed concurrently');
    await recordAudit(tx, identity, {
      action: 'purchase_order.acknowledged',
      entityType: 'purchase_order',
      entityId: poId,
      organizationId: po.organizationId,
      before: { status: 'issued' },
      after: { status: 'acknowledged', supplierRef: updated.supplierRef },
      correlationId: options.correlationId,
    });
    return detailInTx(tx, updated);
  });
}

export async function cancelPurchaseOrder(
  identity: RequestIdentity,
  poId: string,
  input: { reason: string; expectedVersion: number },
  options: ServiceOptions = {},
): Promise<PurchaseOrderDetail> {
  const userId = requireProcurement(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { po, role } = await loadPurchaseOrderAccess(tx, identity, poId, { customer: false });
    if (role !== 'staff') throw new ApiError('forbidden', 'staff action');
    assertVersion(po.version, input.expectedVersion);
    if (['delivered', 'closed', 'cancelled'].includes(po.status))
      throw new ApiError('invalid_transition', `a ${po.status} purchase order cannot be cancelled`);
    const [updated] = await tx
      .update(schema.purchaseOrders)
      .set({ status: 'cancelled', version: po.version + 1 })
      .where(and(eq(schema.purchaseOrders.id, poId), eq(schema.purchaseOrders.version, po.version)))
      .returning();
    if (!updated) throw new ApiError('version_conflict', 'purchase order changed concurrently');
    await appendOutbox(tx, {
      eventType: 'purchase_order.cancelled',
      aggregateType: 'purchase_order',
      aggregateId: poId,
      organizationId: po.organizationId,
      actorUserId: userId,
      payload: {
        purchaseOrderId: poId,
        recipientUserIds: po.supplierUserId ? [po.supplierUserId] : [],
      },
      correlationId: options.correlationId,
    });
    await recordAudit(tx, identity, {
      action: 'purchase_order.cancelled',
      entityType: 'purchase_order',
      entityId: poId,
      organizationId: po.organizationId,
      before: { status: po.status },
      after: { status: 'cancelled' },
      reason: input.reason,
      correlationId: options.correlationId,
    });
    return detailInTx(tx, updated);
  });
}

export async function getPurchaseOrder(
  identity: RequestIdentity,
  poId: string,
  options: ServiceOptions = {},
): Promise<PurchaseOrderDetail> {
  requireProcurement(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { po } = await loadPurchaseOrderAccess(tx, identity, poId);
    return detailInTx(tx, po);
  });
}

/** Staff list all; customers their organisation's; vendors the orders naming them. */
export async function listPurchaseOrders(
  identity: RequestIdentity,
  query: PurchaseOrderListQuery,
  options: ServiceOptions = {},
): Promise<Page<PurchaseOrderDto>> {
  const userId = requireProcurement(identity);
  const cursor = decodeCursor(query.cursor);
  let organizationId = query.organizationId ?? null;
  let supplierUserId: string | null = null;
  if (isStaffIdentity(identity)) {
    assertAllowed(authorizeStaff(identity.actor, 'procurement.manage'));
  } else if (identity.actor.isPartner && !identity.ctx.organizationId) {
    supplierUserId = userId;
  } else {
    organizationId = identity.ctx.organizationId;
    if (!organizationId) return { items: [], nextCursor: null };
    assertAllowed(
      authorizeOrg(identity.actor, 'org.read', { type: 'purchase_order', organizationId }),
    );
  }
  const rows = await withActor(getDb(), ctxFor(identity, options), (tx) =>
    tx
      .select()
      .from(schema.purchaseOrders)
      .where(
        and(
          organizationId ? eq(schema.purchaseOrders.organizationId, organizationId) : undefined,
          supplierUserId ? eq(schema.purchaseOrders.supplierUserId, supplierUserId) : undefined,
          // Suppliers learn about an order only once it is issued.
          supplierUserId ? sql`${schema.purchaseOrders.status} <> 'draft'` : undefined,
          query.status ? eq(schema.purchaseOrders.status, query.status) : undefined,
          query.rfqId ? eq(schema.purchaseOrders.rfqId, query.rfqId) : undefined,
          query.projectId ? eq(schema.purchaseOrders.projectId, query.projectId) : undefined,
          cursor
            ? or(
                lt(schema.purchaseOrders.createdAt, cursor.createdAt),
                and(
                  eq(schema.purchaseOrders.createdAt, cursor.createdAt),
                  lt(schema.purchaseOrders.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.purchaseOrders.createdAt), desc(schema.purchaseOrders.id))
      .limit(query.limit + 1),
  );
  const page = rows.slice(0, query.limit);
  const last = rows.length > query.limit ? page[page.length - 1] : null;
  return {
    items: page.map(toPurchaseOrderDto),
    nextCursor: last ? encodeCursor(last.createdAt, last.id) : null,
  };
}
