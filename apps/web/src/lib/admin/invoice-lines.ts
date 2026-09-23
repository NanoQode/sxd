import { parseNairaToKobo } from './money';

/** A manual invoice line as typed in the admin form (strings until validated). */
export interface InvoiceLineDraft {
  description: string;
  quantity: string;
  unitNaira: string;
  taxPercent: string;
  accountCode: string;
}

/** Tax percent ("7.5") to basis points (750); 0 when blank; null when not a valid 0–100 value. */
export function percentToBps(value: string): number | null {
  if (!value.trim()) return 0;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(value.trim())) return null;
  const bps = Math.round(Number(value) * 100);
  return bps >= 0 && bps <= 10_000 ? bps : null;
}

/** Line validation shared with the preview total; returns a message or null. */
export function lineProblem(line: InvoiceLineDraft): string | null {
  if (!line.description.trim()) return 'Description is required';
  if (!/^\d+(\.\d{1,3})?$/.test(line.quantity) || Number(line.quantity) <= 0)
    return 'Quantity must be positive (up to 3 decimals)';
  const kobo = parseNairaToKobo(line.unitNaira);
  if (kobo === null || BigInt(kobo) < 0n) return 'Unit amount must be a naira amount';
  if (percentToBps(line.taxPercent) === null) return 'Tax must be a percentage between 0 and 100';
  if (line.accountCode && !/^\d{4}$/.test(line.accountCode)) return 'Account code is four digits';
  return null;
}
