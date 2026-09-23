/**
 * Result type shared by every calculator in `@simplexd/domain/finance`.
 *
 * Product rule (build brief §6.4): "If required inputs are absent, return null
 * with a reason; do not invent Nigerian averages." Calculators therefore never
 * throw on bad input and never substitute defaults: they return `ok: false`
 * with a human-readable `reason` and, where inputs are absent, a `missing`
 * list naming exactly what the caller still has to supply.
 */
export type Result<T> = { ok: true; value: T } | { ok: false; reason: string; missing?: string[] };

/** Wraps a successful value. */
export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

/** Builds a failure. `missing` is included only when it names something. */
export function fail<T = never>(reason: string, missing?: readonly string[]): Result<T> {
  return missing !== undefined && missing.length > 0
    ? { ok: false, reason, missing: [...missing] }
    : { ok: false, reason };
}

/** True for a finite `number` (rejects NaN, ±Infinity and every non-number). */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** True unless the value is `undefined` or `null`. */
export function isPresent<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null;
}

/**
 * Collects every missing and invalid input of one call so the caller receives
 * a single failure naming all of them, instead of fixing inputs one at a time.
 * Accessors return `NaN` for a rejected input; read `failed` before trusting
 * the numbers.
 */
export class InputCheck {
  readonly missing: string[] = [];
  readonly invalid: string[] = [];

  /** A signed finite number. */
  number(name: string, value: unknown): number {
    return this.check(name, value, () => true, 'a finite number');
  }

  /** A monetary amount in naira: finite and not negative. */
  amount(name: string, value: unknown): number {
    return this.check(name, value, (n) => n >= 0, 'a finite amount of zero or more');
  }

  /** A finite number strictly greater than zero. */
  positive(name: string, value: unknown): number {
    return this.check(name, value, (n) => n > 0, 'a finite number greater than zero');
  }

  /** A rate expressed as a fraction between 0 and 1 inclusive (0.1 = 10%). */
  fraction(name: string, value: unknown): number {
    return this.check(
      name,
      value,
      (n) => n >= 0 && n <= 1,
      'a fraction between 0 and 1 (0.1 = 10%)',
    );
  }

  /** A whole number of at least `min`. */
  integer(name: string, value: unknown, min = 0): number {
    return this.check(
      name,
      value,
      (n) => Number.isInteger(n) && n >= min,
      `a whole number of ${min} or more`,
    );
  }

  /** Records an input that is absent. */
  absent(name: string): void {
    this.missing.push(name);
  }

  /** Records a problem that is not a simple missing value. */
  problem(message: string): void {
    this.invalid.push(message);
  }

  /**
   * Folds another calculator's failure into this check. Missing names are
   * carried over (prefixed with `prefix.` when given); any other failure is
   * recorded by its reason.
   */
  absorb(result: Result<unknown>, prefix?: string): void {
    if (result.ok) return;
    if (result.missing !== undefined && result.missing.length > 0) {
      this.missing.push(...result.missing.map((name) => (prefix ? `${prefix}.${name}` : name)));
    } else {
      this.invalid.push(prefix ? `${prefix}: ${result.reason}` : result.reason);
    }
  }

  get failed(): boolean {
    return this.missing.length > 0 || this.invalid.length > 0;
  }

  /** The combined failure. Only meaningful once `failed` is true. */
  failure<T = never>(): Result<T> {
    const parts: string[] = [];
    if (this.missing.length > 0) parts.push(`Missing required inputs: ${this.missing.join(', ')}.`);
    if (this.invalid.length > 0) parts.push(`Invalid inputs: ${this.invalid.join('; ')}.`);
    return fail(parts.length > 0 ? parts.join(' ') : 'Invalid inputs.', this.missing);
  }

  private check(name: string, value: unknown, valid: (n: number) => boolean, rule: string): number {
    if (value === undefined || value === null) {
      this.missing.push(name);
      return Number.NaN;
    }
    if (!isFiniteNumber(value) || !valid(value)) {
      this.invalid.push(`${name} must be ${rule}`);
      return Number.NaN;
    }
    return value;
  }
}
