import { DateTime } from 'luxon';

/** Presentation helpers safe for client components (no server imports). */

export function formatNairaString(
  amountKobo: string | bigint | number,
  opts: { compact?: boolean; code?: boolean } = {},
): string {
  const kobo =
    typeof amountKobo === 'bigint'
      ? amountKobo
      : BigInt(typeof amountKobo === 'number' ? Math.round(amountKobo) : amountKobo);
  const negative = kobo < 0n;
  const abs = negative ? -kobo : kobo;
  const prefix = opts.code ? 'NGN ' : '₦';
  if (opts.compact) {
    const naira = Number(abs) / 100;
    const units: Array<[number, string]> = [
      [1_000_000_000, 'bn'],
      [1_000_000, 'm'],
      [1_000, 'k'],
    ];
    for (const [size, suffix] of units) {
      if (naira >= size) {
        const scaled = naira / size;
        return `${negative ? '-' : ''}${prefix}${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1).replace(/\.0$/, '')}${suffix}`;
      }
    }
  }
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = abs % 100n;
  return `${negative ? '-' : ''}${prefix}${frac === 0n ? whole : `${whole}.${frac.toString().padStart(2, '0')}`}`;
}

export function formatWholeNaira(naira: number, opts: { compact?: boolean } = {}): string {
  return formatNairaString(BigInt(Math.round(naira)) * 100n, opts);
}

export function formatDateLabel(iso: string | Date, zone = 'Africa/Lagos'): string {
  const dt =
    typeof iso === 'string' ? DateTime.fromISO(iso, { setZone: true }) : DateTime.fromJSDate(iso);
  return dt.setZone(zone).toFormat('d LLL yyyy');
}

export function formatDateTimeLabel(iso: string | Date, zone = 'Africa/Lagos'): string {
  const dt =
    typeof iso === 'string' ? DateTime.fromISO(iso, { setZone: true }) : DateTime.fromJSDate(iso);
  return dt.setZone(zone).toFormat('d LLL yyyy, HH:mm ZZZZ');
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

export function formatNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-NG', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

export function formatArea(m2: number | string | null | undefined): string {
  if (m2 === null || m2 === undefined) return '—';
  const n = typeof m2 === 'string' ? Number(m2) : m2;
  if (!Number.isFinite(n)) return '—';
  return `${n.toLocaleString('en-NG', { maximumFractionDigits: 1 })} m²`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}
