import type { InputCheck, Result } from './result';
import { fail, isPresent, ok } from './result';

/**
 * What a yield is measured against. Brief §6.4: "Label the denominator as
 * development cost. For a purchase scenario use total acquisition basis
 * instead." The kind is echoed in every result so a yield is never shown
 * without saying what it divides by.
 */
export type CostDenominatorKind = 'development_cost' | 'acquisition_basis';

export interface CostDenominator {
  kind: CostDenominatorKind;
  /** Whole naira. */
  amount: number;
}

export const COST_DENOMINATOR_LABELS: Readonly<Record<CostDenominatorKind, string>> = {
  development_cost: 'development cost',
  acquisition_basis: 'acquisition basis',
};

export function isCostDenominatorKind(kind: unknown): kind is CostDenominatorKind {
  return kind === 'development_cost' || kind === 'acquisition_basis';
}

/** Validates a denominator through a shared `InputCheck`; returns null when it is unusable. */
export function checkDenominator(
  check: InputCheck,
  name: string,
  value: unknown,
): CostDenominator | null {
  if (!isPresent(value) || typeof value !== 'object') {
    check.absent(name);
    return null;
  }
  const candidate = value as { kind?: unknown; amount?: unknown };
  const amount = check.amount(`${name}.amount`, candidate.amount);
  if (!isCostDenominatorKind(candidate.kind)) {
    if (isPresent(candidate.kind)) {
      check.problem(`${name}.kind must be 'development_cost' or 'acquisition_basis'`);
    } else {
      check.absent(`${name}.kind`);
    }
    return null;
  }
  if (!Number.isFinite(amount)) return null;
  return { kind: candidate.kind, amount };
}

/**
 * `numerator / denominator * 100`. Brief §6.4: "No yield when the cost
 * denominator is zero" — that case is a failure, never 0% or Infinity.
 */
export function yieldPercent(numerator: number, denominator: CostDenominator): Result<number> {
  if (!(denominator.amount > 0)) {
    return fail(`No yield: the ${COST_DENOMINATOR_LABELS[denominator.kind]} denominator is zero.`);
  }
  return ok((numerator / denominator.amount) * 100);
}
