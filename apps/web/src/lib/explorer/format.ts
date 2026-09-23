import { formatNairaString, formatNumber, formatPercent, formatWholeNaira } from '@simplexd/ui/format';
import type { ObservationDto } from '@simplexd/contracts';

/** Formats an observation's value with its declared representation; never reinterprets units. */
export function formatObservationValue(
  observation: Pick<
    ObservationDto,
    'value' | 'valueLow' | 'valueHigh' | 'valueText' | 'numericRepresentation' | 'currency'
  >,
): string {
  if (observation.valueText) return observation.valueText;
  const fmt = (n: number): string => {
    switch (observation.numericRepresentation) {
      case 'whole_naira_not_kobo':
        return observation.currency && observation.currency !== 'NGN'
          ? `${observation.currency} ${formatNumber(n)}`
          : formatWholeNaira(n);
      case 'kobo':
        return formatNairaString(String(Math.round(n)));
      case 'percent':
        return formatPercent(n);
      case 'days':
        return `${formatNumber(n, Number.isInteger(n) ? 0 : 1)} days`;
      default:
        return formatNumber(n, Number.isInteger(n) ? 0 : 1);
    }
  };
  if (observation.value !== null) return fmt(observation.value);
  if (observation.valueLow !== null || observation.valueHigh !== null) {
    const low = observation.valueLow !== null ? fmt(observation.valueLow) : '?';
    const high = observation.valueHigh !== null ? fmt(observation.valueHigh) : '?';
    return `${low} – ${high}`;
  }
  return 'Unknown';
}

/** "Month 14" style label for a 0-based month index after construction start. */
export function formatMonthIndex(index: number): string {
  return `month ${index + 1}`;
}

/** Whole naira for scenario figures; negative values keep their sign. */
export function formatScenarioNaira(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return formatWholeNaira(value);
}

export function formatYears(value: number): string {
  return `${value.toFixed(1)} years`;
}

export function formatMultiplier(value: number): string {
  const percent = Math.round((value - 1) * 100);
  return percent === 0 ? 'base' : `${percent > 0 ? '+' : ''}${percent}%`;
}

/** A comparison/metric cell value with its unit; null is "Unknown", never a number. */
export function formatMetricValue(value: number | null, unit: string | null): string {
  if (value === null || !Number.isFinite(value)) return 'Unknown';
  const u = (unit ?? '').trim();
  const lower = u.toLowerCase();
  if (lower.startsWith('ngn') || u.startsWith('₦')) {
    const suffix = lower.includes('/') ? ` ${u.slice(u.indexOf('/'))}` : '';
    return `${formatWholeNaira(value)}${suffix}`;
  }
  if (lower === '%' || lower === 'percent') return formatPercent(value);
  if (lower === 'days' || lower === 'day') return `${formatNumber(value, Number.isInteger(value) ? 0 : 1)} days`;
  if (lower === 'months' || lower === 'month') return `${formatNumber(value, Number.isInteger(value) ? 0 : 1)} months`;
  const digits = Number.isInteger(value) ? 0 : 2;
  return u === '' ? formatNumber(value, digits) : `${formatNumber(value, digits)} ${u}`;
}

/** Plain-text paragraphs from markdown, for profiles rendered without HTML. */
export function plainParagraphs(markdown: string | null | undefined): string[] {
  if (!markdown) return [];
  return markdown
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((block) =>
      block
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^[-*+]\s+/gm, '• ')
        .replace(/[*_`~]+/g, '')
        .replace(/\s*\n\s*/g, ' ')
        .trim(),
    )
    .filter((p) => p !== '');
}
