import {
  evaluateTransition,
  refundMachine,
  type PaymentAttemptState,
  type RefundState,
} from '@simplexd/domain/workflow';
import type { ParsedProviderEvent, ProviderRefundStatus } from './types';
import { asString, isRecord, mapRefundStatus } from './validation';

/**
 * Pure planning of what an authenticated, deduplicated provider event should
 * cause. The application persists the event (provider_events, unique dedupe
 * key) before acknowledging, then runs this planner from the queue with the
 * current state of the records the event references. Nothing here allocates
 * money: `charge.success` only ever yields `verify_and_settle`, and an attempt
 * that is already allocated is ignored, so replays, reordered deliveries and a
 * callback racing a webhook cannot double-allocate.
 */

export type ChargebackStatus = 'opened' | 'evidence_submitted' | 'won' | 'lost' | 'closed';

export interface ExistingRecords {
  /** Status of the payment attempt with `event.reference`; null when none exists. */
  attemptStatus: PaymentAttemptState | null;
  /** True when an allocation row already exists for that attempt. */
  alreadyAllocated: boolean;
  /** Status of the refund record matched by provider refund id / reference; null when none. */
  refundStatus?: RefundState | null;
  /** Status of the chargeback record for the dispute; null when none. */
  chargebackStatus?: ChargebackStatus | null;
}

export type WebhookAction =
  | { kind: 'verify_and_settle'; reference: string }
  | {
      kind: 'update_refund';
      reference: string | null;
      providerRefundId: string | null;
      refundReference: string | null;
      providerStatus: ProviderRefundStatus;
      targetStatus: RefundState;
      needsAttention: boolean;
    }
  | {
      kind: 'open_chargeback';
      reference: string;
      amountKobo: bigint | null;
      currency: string | null;
      providerDisputeId: string | null;
      evidenceDueAt: string | null;
    }
  | {
      kind: 'chargeback_reminder';
      reference: string;
      providerDisputeId: string | null;
      evidenceDueAt: string | null;
    }
  | {
      kind: 'resolve_chargeback';
      reference: string;
      providerDisputeId: string | null;
      resolution: 'won' | 'lost' | 'unknown';
    }
  | { kind: 'flag_for_reconciliation'; reference: string | null; reason: string }
  | { kind: 'ignore'; reason: string };

/**
 * Unique key for `provider_events.dedupe_key`: provider, environment and the
 * stable provider event id. Identical for replays; different for a later state
 * of the same object.
 */
export function deriveDedupeKey(event: ParsedProviderEvent): string {
  return `${event.provider}:${event.environment}:${event.providerEventId}`;
}

const REFUND_TARGETS: Record<ProviderRefundStatus, RefundState> = {
  pending: 'pending',
  processing: 'pending',
  processed: 'settled',
  failed: 'failed',
  needs_attention: 'pending',
};

const REFUND_RANK: Record<RefundState, number> = {
  requested: 0,
  approved: 1,
  submitted: 2,
  pending: 3,
  settled: 4,
  failed: 4,
  rejected: 4,
};

function ignore(reason: string): WebhookAction {
  return { kind: 'ignore', reason };
}

function flag(reference: string | null, reason: string): WebhookAction {
  return { kind: 'flag_for_reconciliation', reference, reason };
}

function planChargeSuccess(event: ParsedProviderEvent, existing: ExistingRecords): WebhookAction[] {
  if (!event.reference) return [flag(null, 'charge.success without a reference')];
  if (existing.attemptStatus === null) {
    return [flag(event.reference, 'charge.success for a reference with no payment attempt')];
  }
  if (existing.alreadyAllocated || existing.attemptStatus === 'successful') {
    return [ignore('attempt already allocated; duplicate or replayed charge.success')];
  }
  if (
    existing.attemptStatus === 'failed' ||
    existing.attemptStatus === 'abandoned' ||
    existing.attemptStatus === 'reversed'
  ) {
    return [
      flag(
        event.reference,
        `charge.success for an attempt already ${existing.attemptStatus}; funds may need manual allocation`,
      ),
    ];
  }
  return [{ kind: 'verify_and_settle', reference: event.reference }];
}

function planRefund(event: ParsedProviderEvent, existing: ExistingRecords): WebhookAction[] {
  const providerStatus = mapRefundStatus(event.status);
  const targetStatus = REFUND_TARGETS[providerStatus];
  const needsAttention = providerStatus === 'needs_attention';
  const current = existing.refundStatus;
  if (current === undefined || current === null) {
    return [
      flag(
        event.reference,
        `${event.eventType} does not match any refund record; it may have been initiated in the provider dashboard`,
      ),
    ];
  }
  if (current === targetStatus) {
    return needsAttention
      ? [flag(event.reference, 'provider refund needs attention (customer bank details required)')]
      : [ignore(`refund already ${current}; replayed ${event.eventType}`)];
  }
  const transition = evaluateTransition(refundMachine, {
    from: current,
    to: targetStatus,
    actor: 'system',
    reason: `provider webhook ${event.eventType}`,
  });
  if (!transition.ok) {
    if (REFUND_RANK[targetStatus] < REFUND_RANK[current]) {
      return [ignore(`stale ${event.eventType}: refund already ${current}`)];
    }
    return [flag(event.reference, `${event.eventType} conflicts with refund status ${current}: ${transition.message}`)];
  }
  const actions: WebhookAction[] = [
    {
      kind: 'update_refund',
      reference: event.reference,
      providerRefundId: event.providerRefundId,
      refundReference: event.refundReference,
      providerStatus,
      targetStatus,
      needsAttention,
    },
  ];
  if (needsAttention) {
    actions.push(flag(event.reference, 'provider refund needs attention (customer bank details required)'));
  }
  return actions;
}

function disputeResolution(payload: Record<string, unknown>): 'won' | 'lost' | 'unknown' {
  // The resolution vocabulary was not verifiable on 2026-09-23 (docs site
  // blocked). Only unmistakable values are mapped; anything else needs a human.
  const resolution = asString(payload.resolution)?.toLowerCase() ?? '';
  if (resolution === 'merchant-accepted' || resolution === 'auto-accepted') return 'lost';
  if (resolution === 'declined') return 'won';
  return 'unknown';
}

function planDispute(event: ParsedProviderEvent, existing: ExistingRecords): WebhookAction[] {
  const payload = event.payload;
  const evidenceDueAt = asString(payload.dueAt) ?? asString(payload.due_at);
  if (!event.reference) return [flag(null, `${event.eventType} without a transaction reference`)];
  if (event.eventType === 'charge.dispute.create') {
    if (existing.chargebackStatus) {
      return [ignore(`chargeback already recorded (${existing.chargebackStatus})`)];
    }
    if (existing.attemptStatus === null) {
      return [flag(event.reference, 'dispute for a reference with no payment attempt')];
    }
    return [
      {
        kind: 'open_chargeback',
        reference: event.reference,
        amountKobo: event.amountKobo,
        currency: event.currency,
        providerDisputeId: event.providerObjectId,
        evidenceDueAt,
      },
    ];
  }
  if (event.eventType === 'charge.dispute.remind') {
    return [
      {
        kind: 'chargeback_reminder',
        reference: event.reference,
        providerDisputeId: event.providerObjectId,
        evidenceDueAt,
      },
    ];
  }
  if (event.eventType === 'charge.dispute.resolve') {
    if (
      existing.chargebackStatus === 'won' ||
      existing.chargebackStatus === 'lost' ||
      existing.chargebackStatus === 'closed'
    ) {
      return [ignore(`chargeback already resolved (${existing.chargebackStatus})`)];
    }
    if (!existing.chargebackStatus) {
      return [flag(event.reference, 'dispute resolution for a chargeback that was never recorded')];
    }
    return [
      {
        kind: 'resolve_chargeback',
        reference: event.reference,
        providerDisputeId: event.providerObjectId,
        resolution: disputeResolution(isRecord(payload) ? payload : {}),
      },
    ];
  }
  return [ignore(`unhandled dispute event ${event.eventType}`)];
}

export function planWebhookActions(
  event: ParsedProviderEvent,
  existing: ExistingRecords,
): WebhookAction[] {
  const type = event.eventType;
  if (type === 'charge.success') return planChargeSuccess(event, existing);
  if (type.startsWith('refund.')) return planRefund(event, existing);
  if (type.startsWith('charge.dispute.')) return planDispute(event, existing);
  if (type.startsWith('transfer.')) {
    return [
      ignore(
        'transfer events are recorded for payout reconciliation; payouts settle only on finance confirmation',
      ),
    ];
  }
  if (type === 'bank.transfer.rejected') {
    return [flag(event.reference, 'bank transfer rejected by the bank; review the related attempt')];
  }
  return [ignore(`unhandled event type ${type}`)];
}
