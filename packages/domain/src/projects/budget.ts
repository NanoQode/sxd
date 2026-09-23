import { maxBigint } from './money-math';

/**
 * Budget variance and forecast. Everything is integer kobo; nothing here reads
 * the database or the clock.
 *
 * Method ("commitment based"): the approved budget is the approved version's
 * base total plus its contingency. Exposure is the higher of what has been
 * contractually committed and what has actually been spent (actuals may run
 * ahead of commitments when uncommitted spend occurs). Cost to complete is
 * the approved budget not yet exposed, floored at zero, so the forecast final
 * cost equals the approved budget until commitments or actuals exceed it.
 * Overruns are therefore recognised when they are evidenced by commitments
 * or actuals, never extrapolated from a percentage.
 *
 * Approved change orders are already inside the approved total (each one
 * created the approved version); they are echoed so the reader can see how
 * much of the budget is change-order driven. Pending change orders are an
 * exposure that is reported separately and never enters the forecast.
 */

export interface BudgetVarianceInput {
  /** Approved version's base total, or null when no version is approved. */
  approvedBaseKobo: bigint | null;
  /** Approved version's contingency (zero when none). */
  contingencyKobo: bigint;
  committedKobo: bigint;
  actualKobo: bigint;
  /** Sum of amountDelta of change orders that were approved and applied. */
  approvedChangeOrderDeltaKobo: bigint;
  /** Sum of amountDelta of change orders submitted and still awaiting decision. */
  pendingChangeOrderDeltaKobo: bigint;
  /** Optional physical progress 0..100 used only for the labelled extrapolation. */
  percentComplete?: number | null;
}

export type BudgetStatus = 'no_approved_budget' | 'within_budget' | 'over_committed' | 'over_spent';

export interface BudgetVariance {
  method: 'commitment_based';
  hasApprovedBudget: boolean;
  approvedBaseKobo: bigint | null;
  contingencyKobo: bigint;
  /** approvedBase + contingency */
  approvedTotalKobo: bigint | null;
  committedKobo: bigint;
  actualKobo: bigint;
  /** max(committed, actual) */
  exposureKobo: bigint;
  /** approvedTotal − exposure; negative means an overrun already evidenced. */
  remainingKobo: bigint | null;
  /** max(remaining, 0): budget assumed to be consumed by work not yet committed. */
  costToCompleteKobo: bigint | null;
  /** exposure + costToComplete = max(approvedTotal, exposure) */
  forecastFinalCostKobo: bigint | null;
  /** approvedTotal − forecastFinalCost; zero or negative (an overrun). */
  varianceKobo: bigint | null;
  /** variance / approvedTotal × 100, rounded to 2 dp; null without a budget. */
  variancePct: number | null;
  approvedChangeOrderDeltaKobo: bigint;
  pendingChangeOrderDeltaKobo: bigint;
  /** approvedTotal + pending deltas: what the budget becomes if every pending change order is approved. */
  exposureIfPendingApprovedKobo: bigint | null;
  /**
   * actual ÷ (percentComplete/100), a scenario figure that assumes spend is
   * linear in physical progress. Null unless progress is between 1 and 100.
   * Labelled so it is never mistaken for the forecast.
   */
  progressExtrapolation: {
    label: 'scenario_not_a_forecast';
    percentComplete: number;
    finalCostKobo: bigint;
  } | null;
  status: BudgetStatus;
  notes: string[];
}

export function computeBudgetVariance(input: BudgetVarianceInput): BudgetVariance {
  const exposure = maxBigint(input.committedKobo, input.actualKobo);
  const notes: string[] = [];
  const progressExtrapolation = extrapolateFromProgress(input.actualKobo, input.percentComplete);

  if (input.approvedBaseKobo === null) {
    notes.push('No approved budget version: commitments and actuals are reported without variance.');
    return {
      method: 'commitment_based',
      hasApprovedBudget: false,
      approvedBaseKobo: null,
      contingencyKobo: input.contingencyKobo,
      approvedTotalKobo: null,
      committedKobo: input.committedKobo,
      actualKobo: input.actualKobo,
      exposureKobo: exposure,
      remainingKobo: null,
      costToCompleteKobo: null,
      forecastFinalCostKobo: null,
      varianceKobo: null,
      variancePct: null,
      approvedChangeOrderDeltaKobo: input.approvedChangeOrderDeltaKobo,
      pendingChangeOrderDeltaKobo: input.pendingChangeOrderDeltaKobo,
      exposureIfPendingApprovedKobo: null,
      progressExtrapolation,
      status: 'no_approved_budget',
      notes,
    };
  }

  const approvedTotal = input.approvedBaseKobo + input.contingencyKobo;
  const remaining = approvedTotal - exposure;
  const costToComplete = remaining > 0n ? remaining : 0n;
  const forecast = exposure + costToComplete;
  const variance = approvedTotal - forecast;
  const variancePct =
    approvedTotal === 0n ? null : Math.round((Number(variance) / Number(approvedTotal)) * 10_000) / 100;

  let status: BudgetStatus = 'within_budget';
  if (input.actualKobo > approvedTotal) status = 'over_spent';
  else if (input.committedKobo > approvedTotal) status = 'over_committed';

  if (input.pendingChangeOrderDeltaKobo !== 0n) {
    notes.push('Pending change orders are shown as exposure and are not part of the forecast until approved.');
  }
  if (input.approvedChangeOrderDeltaKobo !== 0n) {
    notes.push('The approved total already includes every approved and applied change order.');
  }
  if (status !== 'within_budget') {
    notes.push('Commitments or actuals exceed the approved budget; the forecast recognises the evidenced overrun.');
  }

  return {
    method: 'commitment_based',
    hasApprovedBudget: true,
    approvedBaseKobo: input.approvedBaseKobo,
    contingencyKobo: input.contingencyKobo,
    approvedTotalKobo: approvedTotal,
    committedKobo: input.committedKobo,
    actualKobo: input.actualKobo,
    exposureKobo: exposure,
    remainingKobo: remaining,
    costToCompleteKobo: costToComplete,
    forecastFinalCostKobo: forecast,
    varianceKobo: variance,
    variancePct,
    approvedChangeOrderDeltaKobo: input.approvedChangeOrderDeltaKobo,
    pendingChangeOrderDeltaKobo: input.pendingChangeOrderDeltaKobo,
    exposureIfPendingApprovedKobo: approvedTotal + input.pendingChangeOrderDeltaKobo,
    progressExtrapolation,
    status,
    notes,
  };
}

function extrapolateFromProgress(
  actualKobo: bigint,
  percentComplete: number | null | undefined,
): BudgetVariance['progressExtrapolation'] {
  if (
    percentComplete === null ||
    percentComplete === undefined ||
    !Number.isFinite(percentComplete) ||
    percentComplete < 1 ||
    percentComplete > 100
  ) {
    return null;
  }
  const pct = Math.round(percentComplete);
  return {
    label: 'scenario_not_a_forecast',
    percentComplete: pct,
    finalCostKobo: (actualKobo * 100n + BigInt(pct) / 2n) / BigInt(pct),
  };
}

/** Serialises a variance for the wire: bigint → decimal string. */
export function budgetVarianceToJson(v: BudgetVariance): Record<string, unknown> {
  const str = (x: bigint | null): string | null => (x === null ? null : x.toString());
  return {
    method: v.method,
    hasApprovedBudget: v.hasApprovedBudget,
    approvedBaseKobo: str(v.approvedBaseKobo),
    contingencyKobo: v.contingencyKobo.toString(),
    approvedTotalKobo: str(v.approvedTotalKobo),
    committedKobo: v.committedKobo.toString(),
    actualKobo: v.actualKobo.toString(),
    exposureKobo: v.exposureKobo.toString(),
    remainingKobo: str(v.remainingKobo),
    costToCompleteKobo: str(v.costToCompleteKobo),
    forecastFinalCostKobo: str(v.forecastFinalCostKobo),
    varianceKobo: str(v.varianceKobo),
    variancePct: v.variancePct,
    approvedChangeOrderDeltaKobo: v.approvedChangeOrderDeltaKobo.toString(),
    pendingChangeOrderDeltaKobo: v.pendingChangeOrderDeltaKobo.toString(),
    exposureIfPendingApprovedKobo: str(v.exposureIfPendingApprovedKobo),
    progressExtrapolation: v.progressExtrapolation
      ? {
          label: v.progressExtrapolation.label,
          percentComplete: v.progressExtrapolation.percentComplete,
          finalCostKobo: v.progressExtrapolation.finalCostKobo.toString(),
        }
      : null,
    status: v.status,
    notes: v.notes,
  };
}
