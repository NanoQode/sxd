import type { Result } from './result';
import { fail, isFiniteNumber, ok } from './result';

/** Area units with a fixed, exact conversion to square metres. */
export type AreaUnit = 'm2' | 'sqft' | 'acre' | 'hectare';

/**
 * Units a caller may declare. `'plot'` is deliberately part of the type so a
 * declared plot count reaches `convertArea` and is rejected with an
 * explanation, rather than being silently mapped to an assumed size.
 */
export type DeclaredAreaUnit = AreaUnit | 'plot';

export interface DeclaredArea {
  value: number;
  unit: DeclaredAreaUnit;
}

export interface ConvertedArea {
  /** Area in square metres. */
  m2: number;
  /** The declaration exactly as the caller made it, retained for display and audit. */
  declared: { value: number; unit: AreaUnit };
}

/** Square metres in one unit (international definitions, exact). */
export const SQUARE_METRES_PER_UNIT: Readonly<Record<AreaUnit, number>> = {
  m2: 1,
  sqft: 0.09290304, // (0.3048 m)²
  acre: 4046.8564224, // 43,560 sq ft
  hectare: 10_000,
};

/**
 * Brief §6.4: "Plot sizes vary: require actual m² and never assume every plot
 * is 600 m². Area conversion retains the original declared unit."
 */
export const PLOT_IS_NOT_AN_AREA =
  'A plot is not a fixed area: plot sizes vary by location and layout, so a number of plots ' +
  'cannot be converted to square metres (never assume a plot is 600 m²). Declare the surveyed ' +
  'area in m2, sqft, acre or hectare.';

export function isAreaUnit(unit: unknown): unit is AreaUnit {
  return typeof unit === 'string' && Object.hasOwn(SQUARE_METRES_PER_UNIT, unit);
}

/**
 * Converts a declared area to square metres. The result carries the original
 * value and unit untouched so a report can show "2 acres (8,093.71 m²)".
 */
export function convertArea(input: DeclaredArea | null | undefined): Result<ConvertedArea> {
  if (input === null || input === undefined) {
    return fail('An area with a declared unit is required.', ['value', 'unit']);
  }
  const unit: unknown = input.unit;
  const value: unknown = input.value;
  if (unit === undefined || unit === null) {
    return fail('The area unit must be declared (m2, sqft, acre or hectare).', ['unit']);
  }
  if (unit === 'plot') return fail(PLOT_IS_NOT_AN_AREA);
  if (!isAreaUnit(unit)) {
    return fail(`Unknown area unit "${String(unit)}"; use m2, sqft, acre or hectare.`);
  }
  if (value === undefined || value === null) return fail('The area value is required.', ['value']);
  if (!isFiniteNumber(value) || value <= 0) {
    return fail('The area value must be a finite number greater than zero.');
  }
  return ok({ m2: value * SQUARE_METRES_PER_UNIT[unit], declared: { value, unit } });
}
