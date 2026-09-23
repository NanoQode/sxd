/**
 * Pure money helpers for admin forms. Kobo travel as decimal strings on the
 * wire; these helpers never use floating point for the stored value.
 */

/** Parses a naira amount typed by a person ("1,250,000.50") into integer kobo as a string. */
export function parseNairaToKobo(input: string): string | null {
  const cleaned = input.replace(/[₦,\s]/g, '').replace(/^NGN/i, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  const kobo = BigInt(whole!) * 100n + BigInt(frac.padEnd(2, '0'));
  return kobo.toString();
}

/** Sums integer kobo strings without precision loss. */
export function sumKobo(values: Array<string | null | undefined>): string {
  let total = 0n;
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    if (!/^-?\d+$/.test(v)) continue;
    total += BigInt(v);
  }
  return total.toString();
}

/** Multiplies a decimal quantity (up to 3 places) by integer kobo, rounding half up to the kobo. */
export function lineAmountKobo(quantity: string, unitAmountKobo: string): string {
  if (!/^\d+(\.\d{1,3})?$/.test(quantity) || !/^-?\d+$/.test(unitAmountKobo)) return '0';
  const [whole, frac = ''] = quantity.split('.');
  const scaled = BigInt(whole!) * 1000n + BigInt(frac.padEnd(3, '0'));
  const product = scaled * BigInt(unitAmountKobo);
  const negative = product < 0n;
  const abs = negative ? -product : product;
  const rounded = (abs + 500n) / 1000n;
  return (negative ? -rounded : rounded).toString();
}

/** Compares two kobo strings; returns true when they are equal as integers. */
export function koboEqual(a: string, b: string): boolean {
  if (!/^-?\d+$/.test(a) || !/^-?\d+$/.test(b)) return false;
  return BigInt(a) === BigInt(b);
}
