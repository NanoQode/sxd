import type { MetricBound } from './types';

/** Clamps to [0, 1]. NaN passes through unchanged so that a bad value can never hide as 0. */
export function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Human-readable problems with a bound. An empty list means the bound is valid. */
export function boundProblems(bound: MetricBound): string[] {
  const problems: string[] = [];
  if (bound.direction !== 'higher_is_better' && bound.direction !== 'lower_is_better') {
    problems.push(
      `direction must be higher_is_better or lower_is_better, got ${JSON.stringify(bound.direction)}`,
    );
  }
  if (typeof bound.unit !== 'string' || bound.unit.trim() === '') {
    problems.push('unit must be a non-empty string');
  }
  const lowOk = typeof bound.low === 'number' && Number.isFinite(bound.low);
  const highOk = typeof bound.high === 'number' && Number.isFinite(bound.high);
  if (!lowOk) problems.push(`low must be a finite number, got ${String(bound.low)}`);
  if (!highOk) problems.push(`high must be a finite number, got ${String(bound.high)}`);
  if (lowOk && highOk && bound.high <= bound.low) {
    problems.push(`high (${bound.high}) must exceed low (${bound.low})`);
  }
  return problems;
}

export function isValidBound(bound: MetricBound): boolean {
  return boundProblems(bound).length === 0;
}

/**
 * Brief (quoted): "For a higher-is-better metric, `s = clamp((x-low)/(high-low),0,1)`; reverse for
 * lower-is-better." Lower costs and shorter relevant durations therefore score higher.
 *
 * Returns null, never 0 or 1, for a non-finite value or an invalid bound: a missing or broken value
 * must not become a zero price or a perfect score.
 */
export function normaliseScore(value: number, bound: MetricBound): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || !isValidBound(bound)) return null;
  const s = clamp01((value - bound.low) / (bound.high - bound.low));
  return bound.direction === 'higher_is_better' ? s : 1 - s;
}

/** Units are compared after trimming and lower-casing; nothing else is inferred. */
export function normaliseUnit(unit: string): string {
  return unit.trim().toLowerCase();
}

export function unitsMatch(a: string, b: string): boolean {
  return typeof a === 'string' && typeof b === 'string' && normaliseUnit(a) === normaliseUnit(b);
}
