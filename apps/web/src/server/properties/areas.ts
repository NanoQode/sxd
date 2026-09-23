import {
  ApiError,
  type AreaUnit,
  type DeclaredAreaDto,
  type DeclaredAreaInput,
} from '@simplexd/contracts';

/**
 * Area normalisation. The declared value and unit are always stored verbatim;
 * the square-metre figure is derived only when the unit has a fixed
 * definition. A Nigerian "plot" has no fixed size (it differs by state and
 * estate), so plots keep their declared value and no m² is invented.
 */
const M2_PER_UNIT: Record<AreaUnit, number | null> = {
  m2: 1,
  sqft: 0.09290304,
  ha: 10_000,
  acre: 4046.8564224,
  plot: null,
};

export interface NormalisedArea {
  declaredValue: string;
  declaredUnit: AreaUnit;
  m2: string | null;
}

export function normaliseArea(input: DeclaredAreaInput): NormalisedArea {
  const [, fraction = ''] = input.value.split('.');
  if (fraction.length > 3) {
    throw new ApiError('validation_failed', 'declared areas support up to three decimal places', {
      details: [{ path: 'value', message: 'too many decimal places' }],
    });
  }
  const factor = M2_PER_UNIT[input.unit];
  const m2 = factor === null ? null : (Number(input.value) * factor).toFixed(2);
  return { declaredValue: input.value, declaredUnit: input.unit, m2 };
}

export function toDeclaredAreaDto(
  declaredValue: string | null,
  declaredUnit: string | null,
  m2: string | null,
): DeclaredAreaDto | null {
  if (declaredValue === null || declaredUnit === null) {
    // Legacy rows may carry only a square-metre figure; present it honestly as declared in m².
    return m2 === null ? null : { declaredValue: trimDecimal(m2), declaredUnit: 'm2', m2 };
  }
  return { declaredValue: trimDecimal(declaredValue), declaredUnit, m2 };
}

/**
 * Numeric columns come back padded to their scale ("1.500"); the declared
 * figure is shown as the person entered it ("1.5") without changing its value.
 */
export function trimDecimal(value: string): string {
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' || trimmed === '-' ? '0' : trimmed;
}
