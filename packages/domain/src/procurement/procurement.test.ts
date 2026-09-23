import { describe, expect, it } from 'vitest';
import {
  canonicalUnit,
  compareDeliveredCost,
  convertQuantity,
  deliveryVariance,
  discrepancyValueKobo,
  divideRoundHalfUp,
  formatDecimal,
  parseDecimal,
  purchaseOrderStatusAfterDelivery,
  resolveConversion,
} from './index';

describe('exact decimals', () => {
  it('round-trips decimal strings and rounds half up', () => {
    expect(formatDecimal(parseDecimal('12.500'))).toBe('12.5');
    expect(formatDecimal(parseDecimal(0.25))).toBe('0.25');
    expect(formatDecimal(parseDecimal(3n))).toBe('3');
    expect(() => parseDecimal('1.2345678')).toThrow(/decimal places/);
    expect(() => parseDecimal('abc')).toThrow(/invalid decimal/);
    expect(divideRoundHalfUp(5n, 2n)).toBe(3n);
    expect(divideRoundHalfUp(-5n, 2n)).toBe(-3n);
    expect(divideRoundHalfUp(7n, 3n)).toBe(2n);
  });
});

describe('unit normalisation', () => {
  it('treats spelling variants as the same unit but never converts between units', () => {
    expect(canonicalUnit(' Cubic Metres ')).toBe('m3');
    expect(canonicalUnit('m³')).toBe('m3');
    expect(canonicalUnit('Bags')).toBe('bag');
    expect(canonicalUnit('ton')).toBe('ton');
    expect(resolveConversion('m³', 'cubic metre')).toMatchObject({ ok: true, conversion: { direction: 'identity' } });
    expect(resolveConversion('trip', 'm3')).toMatchObject({ ok: false, reason: 'unit_conversion_unknown' });
    expect(resolveConversion('bag', 'kg')).toMatchObject({ ok: false, reason: 'unit_conversion_unknown' });
  });

  it('applies a declared factor in either direction and rejects unrelated or invalid declarations', () => {
    const declared = { fromUnit: 'trip', toUnit: 'm3', factor: '5', basis: 'supplier_declared' as const };
    expect(convertQuantity({ quantity: '3', fromUnit: 'trips', toUnit: 'm³', declaredConversion: declared })).toMatchObject({
      ok: true,
      quantity: '15',
      conversion: { direction: 'declared', basis: 'supplier_declared' },
    });
    expect(convertQuantity({ quantity: '12', fromUnit: 'm3', toUnit: 'trip', declaredConversion: declared })).toMatchObject({
      ok: true,
      quantity: '2.4',
      conversion: { direction: 'inverted' },
    });
    expect(
      resolveConversion('bag', 'kg', { fromUnit: 'trip', toUnit: 'm3', factor: '5', basis: 'staff_measured' }),
    ).toMatchObject({ ok: false, reason: 'unit_conversion_unknown' });
    expect(
      resolveConversion('bag', 'kg', { fromUnit: 'bag', toUnit: 'kg', factor: '0', basis: 'staff_measured' }),
    ).toMatchObject({ ok: false, reason: 'invalid_factor' });
    expect(convertQuantity({ quantity: 'lots', fromUnit: 'bag', toUnit: 'bag' })).toMatchObject({
      ok: false,
      reason: 'invalid_quantity',
    });
  });
});

describe('compareDeliveredCost', () => {
  const items = [
    { itemId: 'sand', material: 'sand', specification: 'sharp sand', unit: 'm3', quantity: '20' },
    { itemId: 'cement', material: 'cement', specification: '42.5R 50kg', unit: 'bag', quantity: '100' },
  ];

  it('ranks fully comparable suppliers by goods plus delivery and surfaces unknown conversions honestly', () => {
    const result = compareDeliveredCost(items, [
      {
        responseId: 'r1',
        supplierLabel: 'Supplier A',
        currency: 'NGN',
        deliveryKobo: '5000000',
        lines: [
          { itemId: 'sand', unitPriceKobo: '9000000', quantityUnit: 'trip', declaredConversion: { fromUnit: 'trip', toUnit: 'm3', factor: '5', basis: 'supplier_declared' } },
          { itemId: 'cement', unitPriceKobo: '1200000', quantityUnit: 'bags' },
        ],
        leadTimeDays: 3,
      },
      {
        responseId: 'r2',
        supplierLabel: 'Supplier B',
        currency: 'NGN',
        deliveryKobo: '2000000',
        lines: [
          { itemId: 'sand', unitPriceKobo: '8000000', quantityUnit: 'trip' },
          { itemId: 'cement', unitPriceKobo: '1100000', quantityUnit: 'bag' },
        ],
      },
      {
        responseId: 'r3',
        supplierLabel: 'Supplier C',
        currency: 'NGN',
        deliveryKobo: null,
        lines: [
          { itemId: 'sand', unitPriceKobo: '1500000', quantityUnit: 'm³' },
          { itemId: 'cement', unitPriceKobo: '1000000', quantityUnit: 'bag' },
        ],
      },
    ]);

    const [a, b, c] = result.entries;
    // A: 20 m3 / 5 m3 per trip = 4 trips × 90,000.00 = 360,000.00 + 100 × 12,000.00 = 1,200,000.00 → goods 1,560,000.00 + delivery 50,000.00
    expect(a).toMatchObject({
      fullyComparable: true,
      goodsKobo: '156000000',
      deliveryKobo: '5000000',
      totalDeliveredKobo: '161000000',
      rank: 1,
    });
    expect(a?.lines[0]).toMatchObject({
      comparable: true,
      supplierUnitsRequired: '4',
      normalizedUnitPriceKobo: '1800000',
      lineTotalKobo: '36000000',
      partialSupplierUnit: false,
      conversion: { fromUnit: 'trip', toUnit: 'm3', factor: '5', basis: 'supplier_declared' },
    });
    // B priced sand per trip without declaring the trip volume: the line and the total stay unknown.
    expect(b).toMatchObject({
      fullyComparable: false,
      goodsKobo: null,
      totalDeliveredKobo: null,
      comparableGoodsKobo: '110000000',
      rank: null,
    });
    expect(b?.unknowns).toEqual([
      { itemId: 'sand', reason: 'unit_conversion_unknown', message: expect.stringContaining('trip') },
    ]);
    // C did not state delivery: goods known, total unknown.
    expect(c).toMatchObject({ goodsKobo: '130000000', deliveryKobo: null, totalDeliveredKobo: null, rank: null });
    expect(c?.unknowns).toEqual([{ itemId: null, reason: 'delivery_unknown', message: 'delivery cost not stated' }]);
    expect(result.ranked).toEqual(['r1']);
  });

  it('flags partial supplier units, missing lines and currency mismatches', () => {
    const result = compareDeliveredCost(
      [{ itemId: 'sand', material: 'sand', specification: 'sharp', unit: 'm3', quantity: '22' }],
      [
        {
          responseId: 'r1',
          supplierLabel: 'A',
          currency: 'NGN',
          deliveryKobo: '0',
          lines: [{ itemId: 'sand', unitPriceKobo: '1000000', quantityUnit: 'trip', declaredConversion: { fromUnit: 'trip', toUnit: 'm3', factor: '5', basis: 'staff_measured' } }],
        },
        { responseId: 'r2', supplierLabel: 'B', currency: 'NGN', deliveryKobo: '0', lines: [] },
        { responseId: 'r3', supplierLabel: 'C', currency: 'USD', deliveryKobo: '0', lines: [{ itemId: 'sand', unitPriceKobo: '100', quantityUnit: 'm3' }] },
      ],
      { currency: 'NGN' },
    );
    expect(result.entries[0]?.lines[0]).toMatchObject({
      supplierUnitsRequired: '4.4',
      lineTotalKobo: '4400000',
      partialSupplierUnit: true,
    });
    expect(result.entries[1]?.unknowns[0]).toMatchObject({ reason: 'line_missing' });
    expect(result.entries[2]?.unknowns[0]).toMatchObject({ reason: 'currency_mismatch' });
    expect(result.ranked).toEqual(['r1']);
  });
});

describe('delivery variance and discrepancy maths', () => {
  it('sums receipts per line and derives the purchase-order progress', () => {
    const ordered = [
      { lineId: 'l1', quantity: '100', unitPriceKobo: '1200000' },
      { lineId: 'l2', quantity: '20', unitPriceKobo: '1500000' },
    ];
    const partial = deliveryVariance(ordered, [
      { lineId: 'l1', quantityReceived: '60' },
      { lineId: 'l1', quantityReceived: '30' },
    ]);
    expect(partial.status).toBe('partially_delivered');
    expect(partial.lines[0]).toMatchObject({ received: '90', outstanding: '10', excess: '0', status: 'short', outstandingValueKobo: '12000000' });
    expect(partial.lines[1]).toMatchObject({ received: '0', status: 'not_received', outstandingValueKobo: '30000000' });
    expect(purchaseOrderStatusAfterDelivery(partial.status)).toBe('partially_delivered');

    const done = deliveryVariance(ordered, [
      { lineId: 'l1', quantityReceived: '100' },
      { lineId: 'l2', quantityReceived: '21.5' },
    ]);
    expect(done.status).toBe('delivered');
    expect(done.lines[1]).toMatchObject({ status: 'over', excess: '1.5', outstanding: '0' });
    expect(deliveryVariance(ordered, []).status).toBe('pending');
    expect(purchaseOrderStatusAfterDelivery('pending')).toBeNull();
  });

  it('values a discrepancy quantity at the unit price with a single rounding', () => {
    expect(discrepancyValueKobo({ quantity: '2.5', unitPriceKobo: '1200001' })).toBe(3000003n);
    expect(discrepancyValueKobo({ quantity: '0.333', unitPriceKobo: 100n })).toBe(33n);
    expect(() => discrepancyValueKobo({ quantity: '-1', unitPriceKobo: 100n })).toThrow(/negative/);
  });
});
