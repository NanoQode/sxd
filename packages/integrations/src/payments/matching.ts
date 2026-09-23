import type { PaymentAttemptState } from '@simplexd/domain/workflow';
import type { VerifyResult } from './types';

/**
 * Pure decision: what a server-side verification means for a payment attempt.
 * Settlement requires provider status `success` AND an exact match on
 * reference, amount and currency. A mismatched amount never settles, even when
 * the provider reports more than expected: the money is real but the invoice
 * allocation would be wrong, so a human reconciles it.
 */

export interface AttemptForMatch {
  reference: string;
  amountKobo: bigint;
  currency: string;
  status: PaymentAttemptState;
}

export interface MatchInput {
  attempt: AttemptForMatch;
  verification: VerifyResult;
  /** Seconds since the attempt was created; decides pending vs uncertain. */
  ageSeconds?: number;
  /** Default 24 hours. */
  uncertainAfterSeconds?: number;
}

export type MatchDecision =
  /** Verified: allocate funds (idempotently) and mark the attempt successful. */
  | 'settle'
  /** Provider says failed/abandoned (or reversed before settlement). */
  | 'fail'
  /** Provider still in flight and the attempt is young. */
  | 'keep_pending'
  /** In flight for too long: mark uncertain; the reconciliation job keeps polling. */
  | 'mark_uncertain'
  /** Provider truth disagrees with our record (amount, currency, reference or status). Never settle. */
  | 'mismatch'
  /** Attempt was settled and the provider now reports a reversal. */
  | 'reverse'
  /** Nothing to do (already in the reported state or stale information). */
  | 'no_change';

export interface MatchOutcome {
  decision: MatchDecision;
  reasons: string[];
  /** Suggested attempt status when the decision changes state. */
  targetStatus?: PaymentAttemptState;
}

export const DEFAULT_UNCERTAIN_AFTER_SECONDS = 24 * 60 * 60;

const FINAL_STATES: ReadonlySet<PaymentAttemptState> = new Set(['failed', 'reversed', 'abandoned']);

function fieldMismatches(attempt: AttemptForMatch, verification: VerifyResult): string[] {
  const reasons: string[] = [];
  if (verification.providerReference !== attempt.reference) {
    reasons.push(
      `reference_mismatch: provider reported ${verification.providerReference ?? 'no reference'} for attempt ${attempt.reference}`,
    );
  }
  if (verification.currency === null || verification.currency !== attempt.currency) {
    reasons.push(
      `currency_mismatch: provider reported ${verification.currency ?? 'no currency'}, attempt is ${attempt.currency}`,
    );
  }
  if (verification.amountKobo === null || verification.amountKobo !== attempt.amountKobo) {
    const provided = verification.amountKobo === null ? 'no amount' : `${verification.amountKobo} kobo`;
    reasons.push(
      `amount_mismatch: provider reported ${provided}, attempt is ${attempt.amountKobo} kobo (never settle a mismatched amount, even when larger)`,
    );
  }
  return reasons;
}

export function matchVerification(input: MatchInput): MatchOutcome {
  const { attempt, verification } = input;
  const threshold = input.uncertainAfterSeconds ?? DEFAULT_UNCERTAIN_AFTER_SECONDS;
  const status = verification.providerStatus;

  if (attempt.status === 'successful') {
    if (status === 'success') {
      const mismatches = fieldMismatches(attempt, verification);
      return mismatches.length === 0
        ? { decision: 'no_change', reasons: ['attempt already settled; allocation is idempotent'] }
        : { decision: 'mismatch', reasons: ['attempt already settled but provider data differs', ...mismatches] };
    }
    if (status === 'reversed') {
      return {
        decision: 'reverse',
        reasons: ['provider reports the settled charge as reversed'],
        targetStatus: 'reversed',
      };
    }
    if (status === 'failed' || status === 'abandoned') {
      return {
        decision: 'mismatch',
        reasons: [`status_conflict: attempt is successful but provider reports ${status}`],
      };
    }
    return { decision: 'no_change', reasons: [`provider status ${status} carries no new information`] };
  }

  if (FINAL_STATES.has(attempt.status)) {
    if (status === 'success') {
      return {
        decision: 'mismatch',
        reasons: [
          `status_conflict: attempt is ${attempt.status} but provider reports success; funds may have arrived after the attempt closed`,
        ],
      };
    }
    return { decision: 'no_change', reasons: [`attempt is final (${attempt.status})`] };
  }

  // initialized | pending | uncertain
  switch (status) {
    case 'success': {
      const mismatches = fieldMismatches(attempt, verification);
      if (mismatches.length > 0) return { decision: 'mismatch', reasons: mismatches };
      return {
        decision: 'settle',
        reasons: ['provider status success; reference, amount and currency match'],
        targetStatus: 'successful',
      };
    }
    case 'failed':
      return {
        decision: 'fail',
        reasons: [`provider reports failed${verification.gatewayResponse ? `: ${verification.gatewayResponse}` : ''}`],
        targetStatus: 'failed',
      };
    case 'abandoned':
      return {
        decision: 'fail',
        reasons: ['provider reports the checkout was abandoned'],
        targetStatus: 'abandoned',
      };
    case 'reversed':
      return {
        decision: 'fail',
        reasons: ['provider reports the charge was reversed before settlement; nothing was allocated'],
        targetStatus: 'failed',
      };
    case 'pending':
    case 'unknown': {
      const age = input.ageSeconds;
      const label = status === 'unknown' ? 'provider status unknown or reference not found' : 'provider still processing';
      if (age !== undefined && age > threshold) {
        if (attempt.status === 'uncertain') {
          return { decision: 'no_change', reasons: [`${label}; attempt already uncertain`] };
        }
        return {
          decision: 'mark_uncertain',
          reasons: [`${label} for ${Math.round(age)} s (> ${threshold} s)`],
          targetStatus: 'uncertain',
        };
      }
      return {
        decision: 'keep_pending',
        reasons: [`${label}; within the ${threshold} s window`],
        targetStatus: attempt.status === 'initialized' ? 'pending' : attempt.status,
      };
    }
    default:
      return { decision: 'mark_uncertain', reasons: ['unrecognised provider status'], targetStatus: 'uncertain' };
  }
}
