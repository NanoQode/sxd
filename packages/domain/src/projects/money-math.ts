/**
 * Integer arithmetic for budget lines. Quantities and areas travel as decimal
 * strings (never floats); amounts are integer kobo (bigint). Every product is
 * rounded half up to the nearest kobo once, at the line level, so a BOQ total
 * is always the exact sum of its stored line amounts.
 */

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

/** Parses a decimal string into an integer scaled by 10^scale (extra digits are rejected). */
export function scaledDecimal(value: string, scale: number): bigint {
  const match = DECIMAL_RE.exec(value.trim());
  if (!match) throw new Error(`invalid decimal "${value}"`);
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > scale) {
    throw new Error(`"${value}" has more than ${scale} decimal places`);
  }
  const scaled = BigInt(whole!) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0') || '0');
  return sign ? -scaled : scaled;
}

/** Divides with round-half-up (away from zero for the positive amounts used here). */
export function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('denominator must be positive');
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const quotient = abs / denominator;
  const remainder = abs % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/** BOQ line amount: quantity (up to 3 decimal places) × rate in kobo, rounded to the kobo. */
export function boqLineAmount(quantity: string, rateKobo: bigint): bigint {
  const scaledQuantity = scaledDecimal(quantity, 3);
  if (scaledQuantity < 0n) throw new Error('quantity must not be negative');
  if (rateKobo < 0n) throw new Error('rate must not be negative');
  return divideRoundHalfUp(scaledQuantity * rateKobo, 1000n);
}

/** Area-rate budget: gross floor area in m² (up to 2 decimal places) × approved rate per m². */
export function areaRateAmount(areaM2: string, rateKoboPerM2: bigint): bigint {
  const scaledArea = scaledDecimal(areaM2, 2);
  if (scaledArea <= 0n) throw new Error('area must be positive');
  if (rateKoboPerM2 < 0n) throw new Error('rate must not be negative');
  return divideRoundHalfUp(scaledArea * rateKoboPerM2, 100n);
}

export function sumBigint(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

export function maxBigint(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
