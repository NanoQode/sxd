/**
 * Money helpers. Ledger money is integer kobo (bigint). Naira is only a
 * presentation/parsing concern. Nothing here uses floating point for ledger
 * arithmetic.
 */

export type Kobo = bigint;

export const NGN = 'NGN' as const;

export interface MoneyJSON {
  /** Decimal string of integer kobo, e.g. "12345". */
  amountKobo: string;
  currency: string;
}

const KOBO_PER_NAIRA = 100n;

export function isKoboString(value: string): boolean {
  return /^-?\d+$/.test(value);
}

/** Parses a JSON/DB decimal string of kobo into a bigint. Throws on invalid input. */
export function parseKobo(value: string | number | bigint): Kobo {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new Error(`kobo must be a safe integer, received ${value}`);
    }
    return BigInt(value);
  }
  const trimmed = value.trim();
  if (!isKoboString(trimmed)) throw new Error(`invalid kobo string "${value}"`);
  return BigInt(trimmed);
}

/**
 * Converts a naira amount written as a decimal string (up to two decimal
 * places) or a number to kobo without floating-point drift.
 */
export function nairaToKobo(naira: string | number): Kobo {
  const text = typeof naira === 'number' ? naira.toFixed(2) : naira.trim().replace(/,/g, '');
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new Error(`invalid naira amount "${naira}"`);
  const sign = match[1] ? -1n : 1n;
  const whole = BigInt(match[2] ?? '0');
  const fraction = (match[3] ?? '').padEnd(2, '0');
  return sign * (whole * KOBO_PER_NAIRA + BigInt(fraction));
}

/** Whole-naira integer (e.g. seed values labelled whole_naira_not_kobo) to kobo. */
export function wholeNairaToKobo(naira: number | bigint): Kobo {
  return BigInt(naira) * KOBO_PER_NAIRA;
}

export function koboToNairaNumber(kobo: Kobo): number {
  return Number(kobo) / 100;
}

/** "1234567.89" style decimal string, no grouping. */
export function koboToDecimalString(kobo: Kobo): string {
  const negative = kobo < 0n;
  const abs = negative ? -kobo : kobo;
  const whole = abs / KOBO_PER_NAIRA;
  const frac = abs % KOBO_PER_NAIRA;
  return `${negative ? '-' : ''}${whole.toString()}.${frac.toString().padStart(2, '0')}`;
}

export interface FormatNairaOptions {
  /** Show "₦" symbol (default) or the ISO code "NGN". */
  style?: 'symbol' | 'code';
  /** Drop ".00" when the amount is whole naira (default true). */
  trimZeroKobo?: boolean;
  /** Compact millions/billions, e.g. ₦150m (default false). */
  compact?: boolean;
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Readable naira formatting: ₦1,234,567.89 or NGN 1,234,567.89. */
export function formatNaira(kobo: Kobo, options: FormatNairaOptions = {}): string {
  const { style = 'symbol', trimZeroKobo = true, compact = false } = options;
  const prefix = style === 'symbol' ? '₦' : 'NGN ';
  const negative = kobo < 0n;
  const abs = negative ? -kobo : kobo;
  if (compact) {
    const naira = Number(abs) / 100;
    const units: Array<[number, string]> = [
      [1_000_000_000, 'bn'],
      [1_000_000, 'm'],
      [1_000, 'k'],
    ];
    for (const [size, suffix] of units) {
      if (naira >= size) {
        const scaled = naira / size;
        const text = scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1).replace(/\.0$/, '');
        return `${negative ? '-' : ''}${prefix}${text}${suffix}`;
      }
    }
  }
  const whole = abs / KOBO_PER_NAIRA;
  const frac = abs % KOBO_PER_NAIRA;
  const wholeText = groupThousands(whole.toString());
  const fracText = frac.toString().padStart(2, '0');
  const body = trimZeroKobo && frac === 0n ? wholeText : `${wholeText}.${fracText}`;
  return `${negative ? '-' : ''}${prefix}${body}`;
}

export function sumKobo(values: Iterable<Kobo>): Kobo {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

/** Basis-point share of an amount, rounded half up. 10000 bps = 100%. */
export function bpsOf(amount: Kobo, bps: number): Kobo {
  if (!Number.isInteger(bps) || bps < 0)
    throw new Error(`bps must be a non-negative integer, received ${bps}`);
  const numerator = amount * BigInt(bps);
  const denominator = 10_000n;
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  // Round half up (away from zero for positives).
  if (remainder * 2n >= denominator) return quotient + 1n;
  return quotient;
}

/**
 * Splits `total` across weights with the largest-remainder method so the parts
 * sum exactly to the total (no lost kobo). Zero total weights split evenly.
 */
export function allocateProRata(total: Kobo, weights: number[]): Kobo[] {
  if (weights.length === 0) return [];
  if (weights.some((w) => w < 0 || !Number.isFinite(w)))
    throw new Error('weights must be finite and non-negative');
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const effective = weightSum === 0 ? weights.map(() => 1) : weights;
  const effSum = effective.reduce((a, b) => a + b, 0);
  const SCALE = 1_000_000n;
  const scaled = effective.map((w) => BigInt(Math.round((w / effSum) * Number(SCALE))));
  const scaledSum = scaled.reduce((a, b) => a + b, 0n);
  const parts = scaled.map((w) => (total * w) / scaledSum);
  let remainder = total - parts.reduce((a, b) => a + b, 0n);
  const fractional = scaled.map((w, i) => ({ i, rem: (total * w) % scaledSum }));
  fractional.sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  const step = remainder < 0n ? -1n : 1n;
  let idx = 0;
  while (remainder !== 0n) {
    const target = fractional[idx % fractional.length]!.i;
    parts[target] = parts[target]! + step;
    remainder -= step;
    idx += 1;
  }
  return parts;
}

export function toMoneyJSON(kobo: Kobo, currency: string = NGN): MoneyJSON {
  return { amountKobo: kobo.toString(), currency };
}

export function fromMoneyJSON(value: MoneyJSON): { kobo: Kobo; currency: string } {
  return { kobo: parseKobo(value.amountKobo), currency: value.currency };
}

export function assertSameCurrency(a: string, b: string): void {
  if (a !== b) throw new Error(`currency mismatch: ${a} vs ${b}`);
}

export function minKobo(a: Kobo, b: Kobo): Kobo {
  return a < b ? a : b;
}

export function maxKobo(a: Kobo, b: Kobo): Kobo {
  return a > b ? a : b;
}
