import { describe, expect, it } from 'vitest';
import type { PurchaseOrderLineDto } from '@simplexd/contracts';
import { normaliseUnit, quantityInSupplierUnit, quotesFromAward } from './supplier-quotes';

const MARKET = '11111111-1111-4111-8111-111111111111';
const SAND = '22222222-2222-4222-8222-222222222222';
const CEMENT = '33333333-3333-4333-8333-333333333333';

const sandLine: PurchaseOrderLineDto = {
  lineId: 'L1',
  itemId: SAND,
  material: 'sand',
  specification: 'Sharp sand',
  unit: 'm3',
  quantity: '20',
  supplierUnit: 'trip',
  unitPriceKobo: '9000000',
  conversion: { fromUnit: 'trip', toUnit: 'm3', factor: '5', basis: 'supplier_declared' },
  lineTotalKobo: '36000000',
};

const cementLine: PurchaseOrderLineDto = {
  lineId: 'L2',
  itemId: CEMENT,
  material: 'cement',
  specification: '42.5R, 50kg',
  unit: 'bag',
  quantity: '100',
  supplierUnit: 'Bag',
  unitPriceKobo: '1200000',
  conversion: null,
  lineTotalKobo: '120000000',
};

function source(overrides: Partial<Parameters<typeof quotesFromAward>[0]> = {}) {
  return {
    rfq: { reference: 'RFQ-2026-0007', deliveryMarketId: MARKET },
    response: {
      supplierFacilityId: null,
      supplierName: null,
      submittedAt: new Date('2026-09-20T09:30:00Z'),
      validUntil: new Date('2026-10-04T00:00:00Z'),
    },
    purchaseOrder: { number: 'PO-2026-0003', createdAt: new Date('2026-09-23T08:00:00Z') },
    lines: [sandLine, cementLine],
    deliveryKobo: '5000000',
    leadTimeDays: { byItemId: new Map([[SAND, 2]]), order: 3 },
    supplierDisplayName: 'Lekki Aggregates Ltd',
    createdBy: 'staff-1',
    ...overrides,
  };
}

describe('quotesFromAward', () => {
  it('maps every order line to a dated, verified, non-rank-eligible quote for the delivery market', () => {
    const rows = quotesFromAward(source());
    expect(rows).toHaveLength(2);
    const [sand, cement] = rows;
    expect(sand).toMatchObject({
      marketId: MARKET,
      material: 'sand',
      specification: 'Sharp sand',
      unit: 'trip',
      quantity: '4.000',
      unitPriceKobo: 9_000_000n,
      deliveryCostKobo: null,
      leadTimeDays: 2,
      quotedAt: '2026-09-20',
      validUntil: '2026-10-04',
      supplierName: 'Lekki Aggregates Ltd',
      reviewStatus: 'verified',
      rankEligible: false,
      contactPermission: false,
      createdBy: 'staff-1',
    });
    expect(sand?.routeConditions).toContain('PO-2026-0003');
    expect(sand?.routeConditions).toContain('RFQ-2026-0007');
    expect(sand?.routeConditions).toContain('₦50,000');
    expect(sand?.routeConditions).toContain('trip = 5 m3 (supplier declared)');
    expect(cement).toMatchObject({
      material: 'cement',
      unit: 'Bag',
      quantity: '100',
      unitPriceKobo: 1_200_000n,
      leadTimeDays: 3,
    });
  });

  it('writes nothing without a delivery market and never invents a quantity or a name', () => {
    expect(quotesFromAward(source({ rfq: { reference: 'RFQ-1', deliveryMarketId: null } }))).toEqual(
      [],
    );
    const [row] = quotesFromAward(
      source({
        lines: [{ ...sandLine, conversion: null }],
        response: {
          supplierFacilityId: null,
          supplierName: null,
          submittedAt: null,
          validUntil: null,
        },
        supplierDisplayName: null,
      }),
    );
    expect(row?.quantity).toBeNull();
    expect(row?.supplierName).toBeNull();
    expect(row?.validUntil).toBeNull();
    // Falls back to the order date when the response was recorded without a submission time.
    expect(row?.quotedAt).toBe('2026-09-23');
    expect(row?.routeConditions).toContain('conversion not declared');
  });

  it('prefers the free-text supplier name and maps unknown materials to other', () => {
    const [row] = quotesFromAward(
      source({
        response: {
          supplierFacilityId: null,
          supplierName: 'Local Depot',
          submittedAt: new Date('2026-09-20T09:30:00Z'),
          validUntil: null,
        },
        lines: [{ ...cementLine, material: 'gravel-ish' }],
      }),
    );
    expect(row?.supplierName).toBe('Local Depot');
    expect(row?.material).toBe('other');
  });
});

describe('quantityInSupplierUnit', () => {
  it('matches units through spelling aliases and converts through a declared factor either way', () => {
    expect(normaliseUnit(' M³ ')).toBe('m3');
    expect(quantityInSupplierUnit({ ...cementLine, supplierUnit: 'BAG' })).toBe('100');
    expect(quantityInSupplierUnit({ ...sandLine, unit: 'm³' })).toBe('4.000');
    expect(
      quantityInSupplierUnit({
        ...sandLine,
        conversion: { fromUnit: 'm3', toUnit: 'trip', factor: '0.2', basis: 'staff_measured' },
      }),
    ).toBe('4.000');
    expect(
      quantityInSupplierUnit({
        ...sandLine,
        conversion: { fromUnit: 'tonne', toUnit: 'kg', factor: '1000', basis: 'staff_measured' },
      }),
    ).toBeNull();
    expect(quantityInSupplierUnit({ ...sandLine, conversion: null })).toBeNull();
  });
});
