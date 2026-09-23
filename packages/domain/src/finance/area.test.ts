import { describe, expect, it } from 'vitest';
import type { DeclaredArea } from './area';
import { convertArea, PLOT_IS_NOT_AN_AREA, SQUARE_METRES_PER_UNIT } from './area';
import type { Result } from './result';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
  return result.value;
}

function failure<T>(result: Result<T>): { reason: string; missing?: string[] } {
  if (result.ok) throw new Error('expected a failure, got ok');
  return result;
}

describe('convertArea', () => {
  it('keeps square metres unchanged and retains the declared value and unit', () => {
    const area = unwrap(convertArea({ value: 450, unit: 'm2' }));
    expect(area.m2).toBe(450);
    expect(area.declared).toEqual({ value: 450, unit: 'm2' });
  });

  it('converts square feet, acres and hectares, retaining the declared unit each time', () => {
    const sqft = unwrap(convertArea({ value: 1000, unit: 'sqft' }));
    expect(sqft.m2).toBeCloseTo(92.90304, 6);
    expect(sqft.declared).toEqual({ value: 1000, unit: 'sqft' });

    const acre = unwrap(convertArea({ value: 2, unit: 'acre' }));
    expect(acre.m2).toBeCloseTo(8093.7128448, 6);
    expect(acre.declared).toEqual({ value: 2, unit: 'acre' });

    const hectare = unwrap(convertArea({ value: 0.5, unit: 'hectare' }));
    expect(hectare.m2).toBe(5000);
    expect(hectare.declared).toEqual({ value: 0.5, unit: 'hectare' });
  });

  it('uses exact international definitions', () => {
    expect(SQUARE_METRES_PER_UNIT.sqft).toBe(0.3048 * 0.3048);
    expect(SQUARE_METRES_PER_UNIT.acre).toBeCloseTo(43_560 * SQUARE_METRES_PER_UNIT.sqft, 6);
  });

  it('rejects "plot" because a plot is not a fixed area (never 600 m²)', () => {
    const rejected = failure(convertArea({ value: 1, unit: 'plot' }));
    expect(rejected.reason).toBe(PLOT_IS_NOT_AN_AREA);
    expect(rejected.reason).toMatch(/not a fixed area/);
    expect(rejected.reason).toMatch(/600 m²/);
    expect(rejected.missing).toBeUndefined();
  });

  it('rejects unknown units and non-positive or non-numeric values', () => {
    const unknown = failure(convertArea({ value: 10, unit: 'furlong' } as unknown as DeclaredArea));
    expect(unknown.reason).toMatch(/Unknown area unit "furlong"/);
    expect(failure(convertArea({ value: 0, unit: 'm2' })).reason).toMatch(/greater than zero/);
    expect(failure(convertArea({ value: -5, unit: 'sqft' })).reason).toMatch(/greater than zero/);
    expect(failure(convertArea({ value: Number.NaN, unit: 'acre' })).reason).toMatch(/finite/);
  });

  it('names the missing fields instead of assuming a unit', () => {
    expect(failure(convertArea({ value: 10 } as unknown as DeclaredArea)).missing).toEqual([
      'unit',
    ]);
    expect(failure(convertArea({ unit: 'm2' } as unknown as DeclaredArea)).missing).toEqual([
      'value',
    ]);
    expect(failure(convertArea(undefined)).missing).toEqual(['value', 'unit']);
  });
});
