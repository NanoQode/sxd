import { describe, expect, it } from 'vitest';
import {
  allocateProRata,
  bpsOf,
  formatNaira,
  koboToDecimalString,
  nairaToKobo,
  parseKobo,
  sumKobo,
  toMoneyJSON,
  wholeNairaToKobo,
} from './index';

describe('money', () => {
  it('parses naira decimals exactly', () => {
    expect(nairaToKobo('150000')).toBe(15_000_000n);
    expect(nairaToKobo('1,234.5')).toBe(123_450n);
    expect(nairaToKobo('0.07')).toBe(7n);
    expect(nairaToKobo(-12.34)).toBe(-1234n);
    expect(() => nairaToKobo('1.234')).toThrow();
    expect(() => nairaToKobo('abc')).toThrow();
  });

  it('converts whole naira seed values to kobo without reinterpretation', () => {
    expect(wholeNairaToKobo(14_000_000)).toBe(1_400_000_000n);
  });

  it('parses and serialises kobo strings', () => {
    expect(parseKobo('12345')).toBe(12345n);
    expect(() => parseKobo('12.5')).toThrow();
    expect(() => parseKobo(1.5)).toThrow();
    expect(toMoneyJSON(999n)).toEqual({ amountKobo: '999', currency: 'NGN' });
    expect(koboToDecimalString(-123456n)).toBe('-1234.56');
  });

  it('formats readable naira', () => {
    expect(formatNaira(15_000_000n)).toBe('₦150,000');
    expect(formatNaira(15_000_050n)).toBe('₦150,000.50');
    expect(formatNaira(15_000_000n, { style: 'code' })).toBe('NGN 150,000');
    expect(formatNaira(35_000_000_000n, { compact: true })).toBe('₦350m');
    expect(formatNaira(150_000_000_000n, { compact: true })).toBe('₦1.5bn');
    expect(formatNaira(-500n)).toBe('-₦5');
  });

  it('computes basis points with half-up rounding', () => {
    expect(bpsOf(1_000_000n, 150)).toBe(15_000n); // 1.5% of ₦10,000
    expect(bpsOf(1n, 5000)).toBe(1n); // 0.5 rounds up
    expect(bpsOf(3n, 3333)).toBe(1n);
    expect(() => bpsOf(1n, -1)).toThrow();
  });

  it('allocates pro rata without losing kobo', () => {
    const parts = allocateProRata(100n, [1, 1, 1]);
    expect(sumKobo(parts)).toBe(100n);
    expect(parts).toEqual([34n, 33n, 33n]);
    const weighted = allocateProRata(1_000n, [0.5, 0.25, 0.25]);
    expect(weighted).toEqual([500n, 250n, 250n]);
    expect(sumKobo(allocateProRata(7n, [0, 0]))).toBe(7n);
  });
});
