import 'server-only';
import { and, eq } from 'drizzle-orm';
import {
  ApiError,
  type DeclaredConversionDto,
  type DeliveryDto,
  type DiscrepancyDto,
  type PurchaseOrderDto,
  type PurchaseOrderLineDto,
  type RfqDto,
  type RfqItemDto,
  type RfqResponseDto,
} from '@simplexd/contracts';
import { schema, type ActorContext, type DbExecutor } from '@simplexd/db';
import {
  assertAllowed,
  authorizeAny,
  authorizeOrg,
  authorizePartner,
  type PartnerPermission,
  type StaffPermission,
} from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';
import { requireFeature } from '@/lib/features';

/**
 * Shared plumbing for materials procurement: feature gate, access
 * resolution for RFQs and purchase orders, JSON column shapes and mappers.
 */

export const PROCUREMENT_FEATURE = 'expansion.materials_procurement';

export interface ServiceOptions {
  correlationId?: string;
}

export type RfqRow = typeof schema.rfqs.$inferSelect;
export type RfqItemRow = typeof schema.rfqItems.$inferSelect;
export type ResponseRow = typeof schema.rfqResponses.$inferSelect;
export type PurchaseOrderRow = typeof schema.purchaseOrders.$inferSelect;
export type DeliveryRow = typeof schema.deliveries.$inferSelect;
export type DiscrepancyRow = typeof schema.discrepancies.$inferSelect;
export type Role = 'staff' | 'customer' | 'supplier';

/** Stored in rfq_responses.lines. */
export interface ResponseLinesJson {
  version: 1;
  deliveryKobo: string;
  leadTimeDays: number | null;
  lines: RfqResponseDto['lines'];
}

/** Stored in purchase_orders.lines. */
export interface PurchaseOrderLinesJson {
  version: 1;
  deliveryKobo: string;
  lines: PurchaseOrderLineDto[];
}

/** Stored in deliveries.lines. */
export type DeliveryLinesJson = DeliveryDto['lines'];

export function requireProcurement(identity: RequestIdentity): string {
  requireFeature(identity, PROCUREMENT_FEATURE);
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  return identity.session.user.id;
}

export function ctxFor(identity: RequestIdentity, options: ServiceOptions = {}): ActorContext {
  return { ...identity.ctx, correlationId: options.correlationId ?? identity.ctx.correlationId };
}

export function isStaffIdentity(identity: RequestIdentity): boolean {
  return identity.actor.staffRoles.length > 0;
}

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function versionConflict(current: number): ApiError {
  return new ApiError(
    'version_conflict',
    'this record changed since you loaded it; reload and try again',
    {
      details: { currentVersion: current },
    },
  );
}

export function assertVersion(current: number, expected: number | undefined): void {
  if (expected !== undefined && current !== expected) throw versionConflict(current);
}

/* -------------------------------------------------------------------------- */
/* Access                                                                     */
/* -------------------------------------------------------------------------- */

export interface RfqAccess {
  rfq: RfqRow;
  role: Role;
  /** The caller's own response row when they are an invited supplier. */
  ownResponse: ResponseRow | null;
}

export async function loadRfqAccess(
  tx: DbExecutor,
  identity: RequestIdentity,
  rfqId: string,
  options: { staff?: StaffPermission[]; supplier?: PartnerPermission; customer?: boolean } = {},
): Promise<RfqAccess> {
  const userId = identity.session?.user.id;
  if (!userId) throw new ApiError('unauthenticated', 'sign in required');
  const [rfq] = await tx.select().from(schema.rfqs).where(eq(schema.rfqs.id, rfqId));
  if (!rfq) throw new ApiError('not_found', 'RFQ not found');
  if (isStaffIdentity(identity)) {
    const perms = options.staff ?? ['procurement.manage'];
    assertAllowed(
      authorizeAny(
        identity.actor,
        perms.map((p) => ({ staff: p })),
        { type: 'rfq', id: rfq.id, organizationId: rfq.organizationId },
      ),
    );
    return { rfq, role: 'staff', ownResponse: null };
  }
  const [own] = await tx
    .select()
    .from(schema.rfqResponses)
    .where(
      and(eq(schema.rfqResponses.rfqId, rfqId), eq(schema.rfqResponses.supplierUserId, userId)),
    );
  if (own && identity.actor.isPartner) {
    assertAllowed(
      authorizePartner(identity.actor, options.supplier ?? 'partner.rfqs.respond', {
        type: 'rfq',
        id: rfq.id,
        assigneeUserIds: [userId],
      }),
    );
    return { rfq, role: 'supplier', ownResponse: own };
  }
  if (options.customer !== false) {
    const decision = authorizeOrg(identity.actor, 'org.read', {
      type: 'rfq',
      id: rfq.id,
      organizationId: rfq.organizationId,
    });
    if (decision.allowed) return { rfq, role: 'customer', ownResponse: null };
  }
  throw new ApiError('not_found', 'RFQ not found');
}

export interface PurchaseOrderAccess {
  po: PurchaseOrderRow;
  role: Role;
}

export async function loadPurchaseOrderAccess(
  tx: DbExecutor,
  identity: RequestIdentity,
  poId: string,
  options: { staff?: StaffPermission[]; supplier?: PartnerPermission; customer?: boolean } = {},
): Promise<PurchaseOrderAccess> {
  const userId = identity.session?.user.id;
  if (!userId) throw new ApiError('unauthenticated', 'sign in required');
  const [po] = await tx
    .select()
    .from(schema.purchaseOrders)
    .where(eq(schema.purchaseOrders.id, poId));
  if (!po) throw new ApiError('not_found', 'purchase order not found');
  if (isStaffIdentity(identity)) {
    const perms = options.staff ?? ['procurement.manage'];
    assertAllowed(
      authorizeAny(
        identity.actor,
        perms.map((p) => ({ staff: p })),
        { type: 'purchase_order', id: po.id, organizationId: po.organizationId },
      ),
    );
    return { po, role: 'staff' };
  }
  // Suppliers learn about an order only once it is issued.
  if (po.supplierUserId === userId && identity.actor.isPartner && po.status !== 'draft') {
    assertAllowed(
      authorizePartner(identity.actor, options.supplier ?? 'partner.deliveries.view', {
        type: 'purchase_order',
        id: po.id,
        assigneeUserIds: [userId],
      }),
    );
    return { po, role: 'supplier' };
  }
  if (options.customer !== false) {
    const decision = authorizeOrg(identity.actor, 'org.read', {
      type: 'purchase_order',
      id: po.id,
      organizationId: po.organizationId,
    });
    if (decision.allowed) return { po, role: 'customer' };
  }
  throw new ApiError('not_found', 'purchase order not found');
}

/* -------------------------------------------------------------------------- */
/* Mappers                                                                    */
/* -------------------------------------------------------------------------- */

export function toRfqDto(row: RfqRow, marketName: string | null): RfqDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    reference: row.reference,
    title: row.title,
    status: row.status,
    deadlineAt: iso(row.deadlineAt),
    deliveryMarketId: row.deliveryMarketId,
    deliveryMarketName: marketName,
    deliveryAddress: (row.deliveryAddress as Record<string, string> | null) ?? null,
    notes: row.notes,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toRfqItemDto(row: RfqItemRow): RfqItemDto {
  return {
    id: row.id,
    rfqId: row.rfqId,
    material: row.material,
    specification: row.specification,
    unit: row.unit,
    quantity: row.quantity,
    sortOrder: row.sortOrder,
  };
}

export function responseLines(row: ResponseRow): ResponseLinesJson {
  const raw = row.lines as Partial<ResponseLinesJson> | null;
  return {
    version: 1,
    deliveryKobo: raw?.deliveryKobo ?? '0',
    leadTimeDays: raw?.leadTimeDays ?? null,
    lines: raw?.lines ?? [],
  };
}

export function toResponseDto(row: ResponseRow): RfqResponseDto {
  const lines = responseLines(row);
  return {
    id: row.id,
    rfqId: row.rfqId,
    supplierUserId: row.supplierUserId,
    supplierName: row.supplierName,
    supplierFacilityId: row.supplierFacilityId,
    status: row.status,
    currency: row.currency,
    lines: lines.lines,
    deliveryKobo: lines.deliveryKobo,
    leadTimeDays: lines.leadTimeDays,
    totalDeliveredKobo: row.totalDeliveredKobo === null ? null : row.totalDeliveredKobo.toString(),
    validUntil: iso(row.validUntil),
    submittedAt: iso(row.submittedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function purchaseOrderLines(row: PurchaseOrderRow): PurchaseOrderLinesJson {
  const raw = row.lines as Partial<PurchaseOrderLinesJson> | null;
  return { version: 1, deliveryKobo: raw?.deliveryKobo ?? '0', lines: raw?.lines ?? [] };
}

export function toPurchaseOrderDto(row: PurchaseOrderRow): PurchaseOrderDto {
  const lines = purchaseOrderLines(row);
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    rfqId: row.rfqId,
    responseId: row.responseId,
    number: row.number,
    status: row.status,
    supplierUserId: row.supplierUserId,
    supplierName: row.supplierName,
    supplierRef: row.supplierRef,
    lines: lines.lines,
    deliveryKobo: lines.deliveryKobo,
    totalKobo: row.totalKobo.toString(),
    currency: row.currency,
    issuedAt: iso(row.issuedAt),
    expectedDeliveryAt: iso(row.expectedDeliveryAt),
    createdBy: row.createdBy,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function deliveryLines(row: DeliveryRow): DeliveryLinesJson {
  const raw = (row.lines as Array<Partial<DeliveryLinesJson[number]>> | null) ?? [];
  return raw.map((l) => ({
    lineId: l.lineId ?? '',
    quantityReceived: l.quantityReceived ?? '0',
    note: l.note ?? null,
    discrepancyIds: l.discrepancyIds ?? [],
  }));
}

export function toDiscrepancyDto(row: DiscrepancyRow, lineId: string | null): DiscrepancyDto {
  return {
    id: row.id,
    deliveryId: row.deliveryId,
    lineId,
    kind: row.kind,
    description: row.description,
    quantity: row.quantity,
    status: row.status,
    resolution: row.resolution,
    createdBy: row.createdBy,
    resolvedAt: iso(row.resolvedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toDeliveryDto(
  row: DeliveryRow,
  purchaseOrderNumber: string,
  discrepancies: DiscrepancyRow[],
): DeliveryDto {
  const lines = deliveryLines(row);
  const lineOf = new Map<string, string>();
  for (const line of lines) for (const id of line.discrepancyIds) lineOf.set(id, line.lineId);
  return {
    id: row.id,
    purchaseOrderId: row.purchaseOrderId,
    purchaseOrderNumber,
    deliveredAt: iso(row.deliveredAt),
    receivedByUserId: row.receivedByUserId,
    lines,
    evidenceFileIds: row.evidenceFileIds ?? [],
    status: row.status,
    note: row.note,
    discrepancies: discrepancies.map((d) => toDiscrepancyDto(d, lineOf.get(d.id) ?? null)),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function conversionOrNull(value: unknown): DeclaredConversionDto | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<DeclaredConversionDto>;
  if (!v.fromUnit || !v.toUnit || !v.factor || !v.basis) return null;
  return { fromUnit: v.fromUnit, toUnit: v.toUnit, factor: String(v.factor), basis: v.basis };
}
