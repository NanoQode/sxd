import { ApiError } from '@simplexd/contracts';
import { schema, type DbExecutor } from '@simplexd/db';
import { bpsOf, parseKobo, type Kobo } from '@simplexd/domain/money';
import { eq } from 'drizzle-orm';

/**
 * Server-side recomputation of line amounts, subtotal, tax and total. Clients
 * only send descriptions, quantities and unit amounts; nothing they send about
 * totals is trusted. Quantities carry up to three decimal places; line
 * amounts round half up to whole kobo.
 */

export interface LineInput {
  description: string;
  quantity?: string;
  unitAmountKobo: string;
  taxRateBps?: number;
  accountCode?: string;
}

export interface ComputedLine {
  description: string;
  quantity: string;
  unitAmountKobo: Kobo;
  amountKobo: Kobo;
  taxRateBps: number;
  taxKobo: Kobo;
  accountCode: string | null;
}

export interface ComputedTotals {
  lines: ComputedLine[];
  subtotalKobo: Kobo;
  taxKobo: Kobo;
  withholdingKobo: Kobo;
  totalKobo: Kobo;
}

export interface TaxTreatmentSnapshot {
  key: string;
  name: string;
  rateBps: number;
  withholdingBps: number;
  appliesTo: string;
  reviewedAt: string | null;
}

const QUANTITY_SCALE = 1000n;

export function quantityToScaled(quantity: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(quantity.trim());
  if (!match) throw new ApiError('validation_failed', `invalid quantity "${quantity}"`);
  return BigInt(match[1]!) * QUANTITY_SCALE + BigInt((match[2] ?? '').padEnd(3, '0'));
}

/** unit × quantity rounded half up to whole kobo. */
export function lineAmount(unitAmountKobo: Kobo, quantity: string): Kobo {
  const numerator = unitAmountKobo * quantityToScaled(quantity);
  const q = numerator / QUANTITY_SCALE;
  const r = numerator % QUANTITY_SCALE;
  return r * 2n >= QUANTITY_SCALE ? q + 1n : q;
}

export function computeTotals(
  inputs: LineInput[],
  treatment: TaxTreatmentSnapshot | null,
): ComputedTotals {
  if (inputs.length === 0) throw new ApiError('validation_failed', 'at least one line is required');
  const lines: ComputedLine[] = inputs.map((input, index) => {
    const unit = parseKobo(input.unitAmountKobo);
    if (unit < 0n) {
      throw new ApiError('validation_failed', `line ${index + 1}: unit amount cannot be negative`);
    }
    const quantity = input.quantity ?? '1';
    const amountKobo = lineAmount(unit, quantity);
    const taxRateBps = input.taxRateBps ?? treatment?.rateBps ?? 0;
    return {
      description: input.description,
      quantity,
      unitAmountKobo: unit,
      amountKobo,
      taxRateBps,
      taxKobo: taxRateBps > 0 ? bpsOf(amountKobo, taxRateBps) : 0n,
      accountCode: input.accountCode ?? null,
    };
  });
  let subtotalKobo = 0n;
  let taxKobo = 0n;
  for (const line of lines) {
    subtotalKobo += line.amountKobo;
    taxKobo += line.taxKobo;
  }
  const withholdingKobo =
    treatment && treatment.withholdingBps > 0 ? bpsOf(subtotalKobo, treatment.withholdingBps) : 0n;
  return { lines, subtotalKobo, taxKobo, withholdingKobo, totalKobo: subtotalKobo + taxKobo };
}

/** Loads an active tax treatment by key; `none` and a missing key both mean no tax. */
export async function loadTaxTreatment(
  tx: DbExecutor,
  key: string | null | undefined,
): Promise<TaxTreatmentSnapshot | null> {
  if (!key || key === 'none') return null;
  const [row] = await tx
    .select()
    .from(schema.taxTreatments)
    .where(eq(schema.taxTreatments.key, key));
  if (!row) throw new ApiError('validation_failed', `unknown tax treatment "${key}"`);
  if (!row.active) {
    throw new ApiError('validation_failed', `tax treatment "${key}" is not active (pending accountant review)`);
  }
  return {
    key: row.key,
    name: row.name,
    rateBps: row.rateBps,
    withholdingBps: row.withholdingBps,
    appliesTo: row.appliesTo,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
  };
}

export function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

export function kobo(value: Kobo | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toString();
}
