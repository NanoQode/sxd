import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, schema } from '@simplexd/db';
import { connectTestDatabases, resetDatabase, type TestDatabases } from '@simplexd/db/testing';
import { seedAndPublish } from '@/server/markets/test-fixtures';
import {
  customerIdentity,
  enableCommercialFlags,
  hoursFromNow,
  insertOrganization,
  insertPartner,
  insertStaff,
  partnerIdentity,
  staffIdentity,
} from '@/server/tenders/test-fixtures';
import { acceptDelivery, getDelivery, listDeliveries, openDiscrepancy, recordDelivery, transitionDiscrepancy } from './deliveries';
import { acknowledgePurchaseOrder, createPurchaseOrder, getPurchaseOrder, issuePurchaseOrder, listPurchaseOrders } from './purchase-orders';
import { createRfq, getRfq, getRfqComparison, issueRfq, listRfqs, submitRfqResponse, withdrawRfqResponse } from './rfqs';
import { listSupplierDirectory } from './suppliers';

let dbs: TestDatabases;
const staff = staffIdentity('prc-staff', ['operations_manager']);
const vendorA = partnerIdentity('prc-vendor-a');
const vendorB = partnerIdentity('prc-vendor-b');
const customer = customerIdentity('prc-customer', 'prc-org-a');
const stranger = customerIdentity('prc-stranger', 'prc-org-b');
let lagosId: string;

beforeAll(async () => {
  dbs = connectTestDatabases();
  await resetDatabase(dbs.owner);
  await seedAndPublish(dbs.owner);
  await enableCommercialFlags(dbs.owner);
  await insertStaff(dbs.owner, 'prc-staff', ['operations_manager']);
  await insertPartner(dbs.owner, 'prc-vendor-a', 'vendor');
  await insertPartner(dbs.owner, 'prc-vendor-b', 'vendor');
  await insertOrganization(dbs.owner, 'prc-org-a', [{ userId: 'prc-customer', role: 'owner' }]);
  await insertOrganization(dbs.owner, 'prc-org-b', [{ userId: 'prc-stranger', role: 'owner' }]);
  const [lagos] = await dbs.owner.select({ id: schema.markets.id }).from(schema.markets).where(eq(schema.markets.slug, 'ng-lagos'));
  lagosId = lagos!.id;
});

afterAll(async () => {
  await closeDb();
  await dbs.close();
});

describe('supplier directory', () => {
  it('lists seeded facilities with their evidence labels and never invents a price', async () => {
    const directory = await listSupplierDirectory(staff, { material: 'cement', includeArchived: 'false' });
    expect(directory.items.length).toBeGreaterThan(0);
    for (const item of directory.items) {
      expect(item.material).toBe('cement');
      expect(item.evidenceLabel.length).toBeGreaterThan(0);
      expect(item.quotes).toEqual([]);
      expect(item.priceEvidence).toBe('no_quote_on_file');
    }
    await expect(listSupplierDirectory(customer, { includeArchived: 'false' })).rejects.toMatchObject({ name: 'AuthorizationError' });
  });
});

describe('RFQ → responses → comparison → purchase order → delivery → discrepancy', () => {
  it('compares delivered cost honestly and isolates vendors', async () => {
    const rfq = await createRfq(staff, {
      organizationId: 'prc-org-a',
      title: 'Foundation materials, Lekki site',
      deliveryMarketId: lagosId,
      items: [
        { material: 'sand', specification: 'Sharp sand', unit: 'm3', quantity: '20' },
        { material: 'cement', specification: '42.5R, 50kg', unit: 'bag', quantity: '100' },
      ],
    });
    expect(rfq.reference).toMatch(/^RFQ-\d{4}-\d{4}$/);
    const [sand, cement] = rfq.items;
    await expect(submitRfqResponse(vendorA, rfq.id, { currency: 'NGN', lines: [], deliveryKobo: '0', submit: true } as never)).rejects.toMatchObject({ code: 'not_found' });

    const issued = await issueRfq(staff, rfq.id, { deadlineAt: hoursFromNow(24), supplierUserIds: ['prc-vendor-a', 'prc-vendor-b'] });
    expect(issued.status).toBe('sent');
    expect(issued.responses.map((r) => r.status)).toEqual(['draft', 'draft']);
    const outbox = await dbs.owner.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, 'rfq.issued'));
    expect(outbox[0]?.payload).toMatchObject({ rfqId: rfq.id, recipientUserIds: ['prc-vendor-a', 'prc-vendor-b'] });

    // Vendor A declares how much a trip carries; vendor B does not.
    const responseA = await submitRfqResponse(vendorA, rfq.id, {
      currency: 'NGN',
      lines: [
        { itemId: sand!.id, unitPriceKobo: '9000000', quantityUnit: 'trip', declaredConversion: { fromUnit: 'trip', toUnit: 'm3', factor: '5', basis: 'supplier_declared' } },
        { itemId: cement!.id, unitPriceKobo: '1200000', quantityUnit: 'bags' },
      ],
      deliveryKobo: '5000000',
      leadTimeDays: 3,
      submit: true,
    });
    expect(responseA.status).toBe('submitted');
    expect(responseA.totalDeliveredKobo).toBe('161000000');
    const responseB = await submitRfqResponse(vendorB, rfq.id, {
      currency: 'NGN',
      lines: [
        { itemId: sand!.id, unitPriceKobo: '8000000', quantityUnit: 'trip' },
        { itemId: cement!.id, unitPriceKobo: '1100000', quantityUnit: 'bag' },
      ],
      deliveryKobo: '2000000',
      submit: true,
    });
    expect(responseB.totalDeliveredKobo).toBeNull();
    const manual = await submitRfqResponse(staff, rfq.id, {
      supplierName: 'Local Depot',
      currency: 'NGN',
      lines: [
        { itemId: sand!.id, unitPriceKobo: '1600000', quantityUnit: 'm³' },
        { itemId: cement!.id, unitPriceKobo: '1250000', quantityUnit: 'bag' },
      ],
      deliveryKobo: '0',
      submit: true,
    });
    expect(manual.supplierUserId).toBeNull();

    // Vendor isolation.
    expect((await getRfq(vendorA, rfq.id)).responses.map((r) => r.id)).toEqual([responseA.id]);
    expect((await listRfqs(vendorB, { limit: 10 })).items.map((r) => r.id)).toEqual([rfq.id]);
    await expect(getRfqComparison(vendorB, rfq.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(withdrawRfqResponse(vendorA, rfq.id, responseB.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(getRfq(stranger, rfq.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await listRfqs(stranger, { limit: 10 })).items).toEqual([]);

    // Comparison: unknown conversion surfaces honestly and is excluded from ranking.
    const comparison = await getRfqComparison(customer, rfq.id);
    const entryA = comparison.entries.find((e) => e.responseId === responseA.id)!;
    const entryB = comparison.entries.find((e) => e.responseId === responseB.id)!;
    const entryM = comparison.entries.find((e) => e.responseId === manual.id)!;
    expect(entryA).toMatchObject({ fullyComparable: true, totalDeliveredKobo: '161000000', rank: 2 });
    expect(entryM).toMatchObject({ fullyComparable: true, totalDeliveredKobo: '157000000', rank: 1 });
    expect(entryB).toMatchObject({ fullyComparable: false, totalDeliveredKobo: null, rank: null });
    expect(entryB.unknowns).toEqual([{ itemId: sand!.id, reason: 'unit_conversion_unknown', message: expect.any(String) }]);
    expect(comparison.ranked).toEqual([manual.id, responseA.id]);

    // Purchase orders: unknown conversions block ordering until staff declare a measured factor.
    await expect(createPurchaseOrder(staff, { responseId: responseB.id, lineConversions: [] })).rejects.toMatchObject({ code: 'validation_failed' });
    const poFromB = await createPurchaseOrder(staff, {
      responseId: responseB.id,
      lineConversions: [{ itemId: sand!.id, declaredConversion: { fromUnit: 'trip', toUnit: 'm3', factor: '4', basis: 'staff_measured' } }],
    });
    expect(poFromB.totalKobo).toBe(String(5 * 8_000_000 + 100 * 1_100_000 + 2_000_000));
    const po = await createPurchaseOrder(staff, { responseId: responseA.id, lineConversions: [] });
    expect(po.number).toMatch(/^PO-\d{4}-\d{4}$/);
    expect(po.status).toBe('draft');
    expect(po.totalKobo).toBe('161000000');
    expect(po.lines.map((l) => l.lineTotalKobo)).toEqual(['36000000', '120000000']);
    await expect(getPurchaseOrder(vendorA, po.id)).rejects.toMatchObject({ code: 'not_found' });
    const issuedPo = await issuePurchaseOrder(staff, po.id, { expectedVersion: po.version });
    expect(issuedPo.status).toBe('issued');
    expect((await getRfq(staff, rfq.id)).status).toBe('awarded');
    expect((await getRfq(vendorA, rfq.id)).responses[0]?.status).toBe('selected');
    const poEvents = await dbs.owner.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, 'purchase_order.issued'));
    expect(poEvents[0]?.payload).toMatchObject({ purchaseOrderId: po.id, recipientUserIds: ['prc-vendor-a'] });

    // Vendors see only orders naming them.
    expect((await listPurchaseOrders(vendorA, { limit: 10 })).items.map((p) => p.id)).toEqual([po.id]);
    expect((await listPurchaseOrders(vendorB, { limit: 10 })).items).toEqual([]);
    await expect(acknowledgePurchaseOrder(vendorB, po.id, {})).rejects.toMatchObject({ code: 'not_found' });
    const acknowledged = await acknowledgePurchaseOrder(vendorA, po.id, { supplierRef: 'SO-771', expectedVersion: issuedPo.version });
    expect(acknowledged.status).toBe('acknowledged');
    expect((await listPurchaseOrders(customer, { limit: 10 })).items.map((p) => p.id).sort()).toEqual([po.id, poFromB.id].sort());

    // Delivery: short on sand.
    const delivery = await recordDelivery(staff, po.id, {
      deliveredAt: new Date().toISOString(),
      lines: [
        { lineId: 'L1', quantityReceived: '15' },
        { lineId: 'L2', quantityReceived: '100' },
      ],
      evidenceFileIds: [],
      note: 'Three trips arrived, one short',
    });
    expect(delivery.status).toBe('received');
    const progress = await getPurchaseOrder(staff, po.id);
    expect(progress.status).toBe('partially_delivered');
    expect(progress.deliveryProgress.lines[0]).toMatchObject({ lineId: 'L1', outstanding: '5', status: 'short' });
    const discrepancy = await openDiscrepancy(staff, delivery.id, { lineId: 'L1', kind: 'short_delivery', description: '5 m3 of sand missing', quantity: '5' });
    expect(discrepancy.status).toBe('open');
    expect(discrepancy.lineId).toBe('L1');
    expect((await getDelivery(vendorA, delivery.id)).status).toBe('disputed');
    await expect(getDelivery(vendorB, delivery.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await listDeliveries(vendorA, { limit: 10 })).items.map((d) => d.id)).toEqual([delivery.id]);
    expect((await listDeliveries(vendorB, { limit: 10 })).items).toEqual([]);
    await expect(acceptDelivery(staff, delivery.id)).rejects.toMatchObject({ code: 'invalid_transition' });
    await expect(transitionDiscrepancy(staff, delivery.id, discrepancy.id, { to: 'resolved', resolution: 'skip' })).rejects.toMatchObject({ code: 'invalid_transition' });
    await transitionDiscrepancy(staff, delivery.id, discrepancy.id, { to: 'supplier_notified' });
    const credited = await transitionDiscrepancy(staff, delivery.id, discrepancy.id, { to: 'credited', resolution: 'Supplier credited 5 m3 on the next invoice' });
    expect(credited.resolvedAt).not.toBeNull();
    expect((await acceptDelivery(staff, delivery.id)).status).toBe('accepted');
    const disputeEvents = await dbs.owner.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, 'delivery.discrepancy.opened'));
    expect(disputeEvents[0]?.payload).toMatchObject({ discrepancyId: discrepancy.id, recipientUserIds: ['prc-vendor-a'] });
  });
});
