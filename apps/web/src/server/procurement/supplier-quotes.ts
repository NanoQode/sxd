import 'server-only';
import { eq } from 'drizzle-orm';
import type { PurchaseOrderLineDto } from '@simplexd/contracts';
import { schema, type DbExecutor } from '@simplexd/db';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import {
  purchaseOrderLines,
  responseLines,
  type PurchaseOrderRow,
  type ResponseRow,
  type RfqRow,
  type ServiceOptions,
} from './shared';

/**
 * Verified supplier quotations for the location panel (brief §6.2) come from
 * procurement that actually happened: when a purchase order is issued, the
 * accepted RFQ response becomes one `supplier_quotes` row per order line for
 * the RFQ's delivery market, dated by the supplier's submission and carrying
 * its provenance (order and RFQ references) in the route/terms text.
 *
 * Rows are `verified` operational records (a real accepted price), visible
 * on the public panel with that badge, and never rank-eligible by default:
 * whether a single accepted quote may feed the ranking is a business review
 * decision, not an automatic consequence of ordering.
 */

export type SupplierQuoteInsert = typeof schema.supplierQuotes.$inferInsert;
type Material = SupplierQuoteInsert['material'];

const MATERIALS: ReadonlySet<string> = new Set(schema.materialEnum.enumValues);

export interface AwardSource {
  rfq: Pick<RfqRow, 'reference' | 'deliveryMarketId'>;
  response: Pick<ResponseRow, 'supplierFacilityId' | 'supplierName' | 'submittedAt' | 'validUntil'>;
  purchaseOrder: Pick<PurchaseOrderRow, 'number' | 'createdAt'>;
  lines: readonly PurchaseOrderLineDto[];
  /** Delivery quoted for the whole order, in kobo. */
  deliveryKobo: string;
  /** Lead time per RFQ item (from the response line) and for the whole response. */
  leadTimeDays: { byItemId: ReadonlyMap<string, number | null>; order: number | null };
  /** Display name when the response names a supplier account rather than a free-text supplier. */
  supplierDisplayName: string | null;
  createdBy: string | null;
}

export function normaliseUnit(unit: string): string {
  return unit.trim().toLowerCase().replace(/³/g, '3').replace(/\s+/g, '');
}

/**
 * The quoted quantity expressed in the supplier's pricing unit: the buyer's
 * quantity when the units match, converted through the declared factor when
 * one exists, otherwise unknown (null). Never assumed.
 */
export function quantityInSupplierUnit(line: PurchaseOrderLineDto): string | null {
  const buyer = normaliseUnit(line.unit);
  const supplier = normaliseUnit(line.supplierUnit);
  if (buyer === supplier) return line.quantity;
  const c = line.conversion;
  if (!c) return null;
  const factor = Number(c.factor);
  const quantity = Number(line.quantity);
  if (!Number.isFinite(factor) || factor <= 0 || !Number.isFinite(quantity)) return null;
  const from = normaliseUnit(c.fromUnit);
  const to = normaliseUnit(c.toUnit);
  if (from === supplier && to === buyer) return (quantity / factor).toFixed(3);
  if (from === buyer && to === supplier) return (quantity * factor).toFixed(3);
  return null;
}

function naira(kobo: string): string {
  const whole = BigInt(kobo) / 100n;
  return `₦${whole.toLocaleString('en-NG')}`;
}

const dateOnly = (d: Date): string => d.toISOString().slice(0, 10);

/** Pure mapping from an issued purchase order to the supplier quote rows it evidences. */
export function quotesFromAward(source: AwardSource): SupplierQuoteInsert[] {
  const marketId = source.rfq.deliveryMarketId;
  if (!marketId) return [];
  const quotedAt = dateOnly(source.response.submittedAt ?? source.purchaseOrder.createdAt);
  const validUntil = source.response.validUntil ? dateOnly(source.response.validUntil) : null;
  const supplierName = source.response.supplierName ?? source.supplierDisplayName;
  const provenance = `Accepted quotation under ${source.purchaseOrder.number} (${source.rfq.reference}); delivery ${naira(source.deliveryKobo)} quoted for the whole order`;
  return source.lines.map((line) => {
    const material: Material = MATERIALS.has(line.material) ? (line.material as Material) : 'other';
    const conversion = line.conversion
      ? `; ${line.conversion.fromUnit} = ${line.conversion.factor} ${line.conversion.toUnit} (${line.conversion.basis.replace(/_/g, ' ')})`
      : normaliseUnit(line.unit) === normaliseUnit(line.supplierUnit)
        ? ''
        : `; priced per ${line.supplierUnit}, ordered in ${line.unit} (conversion not declared)`;
    return {
      facilityId: source.response.supplierFacilityId,
      supplierName,
      marketId,
      material,
      specification: line.specification,
      unit: line.supplierUnit,
      quantity: quantityInSupplierUnit(line),
      unitPriceKobo: BigInt(line.unitPriceKobo),
      deliveryCostKobo: null,
      taxesKobo: null,
      unloadingKobo: null,
      leadTimeDays:
        (line.itemId ? source.leadTimeDays.byItemId.get(line.itemId) : null) ??
        source.leadTimeDays.order,
      routeConditions: `${provenance}${conversion}.`,
      quotedAt,
      validUntil,
      contactPermission: false,
      evidenceFileId: null,
      reviewStatus: 'verified',
      rankEligible: false,
      createdBy: source.createdBy,
    };
  });
}

/**
 * Writes the supplier quotes an issued purchase order evidences. Runs inside
 * the issuing transaction (staff context: `supplier_quotes` is staff-write).
 * Returns the ids written; nothing is written without a delivery market.
 */
export async function recordSupplierQuotesFromAward(
  tx: DbExecutor,
  identity: RequestIdentity,
  po: PurchaseOrderRow,
  options: ServiceOptions = {},
): Promise<string[]> {
  if (!po.rfqId || !po.responseId) return [];
  const [rfq] = await tx.select().from(schema.rfqs).where(eq(schema.rfqs.id, po.rfqId));
  const [response] = await tx
    .select()
    .from(schema.rfqResponses)
    .where(eq(schema.rfqResponses.id, po.responseId));
  if (!rfq || !response || !rfq.deliveryMarketId) return [];
  let supplierDisplayName: string | null = null;
  if (!response.supplierName && response.supplierUserId) {
    const [supplier] = await tx
      .select({ name: schema.user.name })
      .from(schema.user)
      .where(eq(schema.user.id, response.supplierUserId));
    supplierDisplayName = supplier?.name ?? null;
  }
  const order = purchaseOrderLines(po);
  const responded = responseLines(response);
  const rows = quotesFromAward({
    rfq,
    response,
    purchaseOrder: po,
    lines: order.lines,
    deliveryKobo: order.deliveryKobo,
    leadTimeDays: {
      byItemId: new Map(responded.lines.map((l) => [l.itemId, l.leadTimeDays ?? null])),
      order: responded.leadTimeDays,
    },
    supplierDisplayName,
    createdBy: identity.session?.user.id ?? null,
  });
  if (rows.length === 0) return [];
  const inserted = await tx
    .insert(schema.supplierQuotes)
    .values(rows)
    .returning({ id: schema.supplierQuotes.id });
  const ids = inserted.map((r) => r.id);
  for (const [index, id] of ids.entries()) {
    const row = rows[index]!;
    await recordAudit(tx, identity, {
      action: 'supplier_quote.recorded',
      entityType: 'supplier_quote',
      entityId: id,
      organizationId: po.organizationId,
      after: {
        purchaseOrderId: po.id,
        purchaseOrderNumber: po.number,
        rfqId: rfq.id,
        marketId: row.marketId,
        material: row.material,
        unit: row.unit,
        unitPriceKobo: row.unitPriceKobo?.toString() ?? null,
        quotedAt: row.quotedAt,
      },
      correlationId: options.correlationId,
    });
  }
  return ids;
}
