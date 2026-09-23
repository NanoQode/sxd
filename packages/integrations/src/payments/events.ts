import { createHash } from 'node:crypto';
import { ProviderError } from './errors';
import { sanitizeProviderRecord } from './sanitize';
import type { ParsedProviderEvent, PaymentProviderId } from './types';
import { asIdString, asString, detectDomain, isRecord, parseProviderAmount } from './validation';

/** Event names verified from Paystack's official sample files on 2026-09-23. */
export const PAYSTACK_EVENT_TYPES = [
  'charge.success',
  'charge.dispute.create',
  'charge.dispute.remind',
  'charge.dispute.resolve',
  'refund.pending',
  'refund.processing',
  'refund.processed',
  'refund.failed',
  'refund.needs-attention',
  'transfer.success',
  'transfer.failed',
  'transfer.reversed',
  'bank.transfer.rejected',
  'customeridentification.success',
  'customeridentification.failed',
  'dedicatedaccount.assign.success',
  'dedicatedaccount.assign.failed',
  'invoice.create',
  'invoice.update',
  'invoice.payment_failed',
  'paymentrequest.pending',
  'paymentrequest.success',
  'subscription.create',
  'subscription.disable',
  'subscription.not_renew',
  'subscription.expiring_cards',
] as const;

export type PaystackEventType = (typeof PAYSTACK_EVENT_TYPES)[number];

const TIMESTAMP_KEYS = [
  'paid_at',
  'paidAt',
  'updated_at',
  'updatedAt',
  'created_at',
  'createdAt',
  'transferred_at',
] as const;

function hashEventIdentity(parts: Array<string | null>): string {
  return createHash('sha256')
    .update(parts.map((p) => p ?? '').join('|'), 'utf8')
    .digest('hex')
    .slice(0, 32);
}

/**
 * Parses a Paystack-shaped webhook body (`{ event, data }`). Signature
 * verification must happen before this is called; the parser trusts nothing
 * about the payload beyond its shape.
 */
export function parseProviderWebhookBody(
  rawBody: Buffer | string,
  provider: PaymentProviderId,
): ParsedProviderEvent {
  const text = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ProviderError('invalid_request', 'webhook body is not valid JSON');
  }
  if (!isRecord(json) || typeof json.event !== 'string' || !isRecord(json.data)) {
    throw new ProviderError('invalid_request', 'webhook body is not a { event, data } envelope');
  }
  const eventType = json.event.trim().toLowerCase();
  if (!eventType) throw new ProviderError('invalid_request', 'webhook event name is empty');
  const data = json.data;
  const transaction = isRecord(data.transaction) ? data.transaction : null;
  const isDispute = eventType.startsWith('charge.dispute');
  const isRefund = eventType.startsWith('refund.');

  const reference =
    asString(data.reference) ??
    asString(data.transaction_reference) ??
    (transaction ? asString(transaction.reference) : null);
  const refundReference = asString(data.refund_reference);
  const providerObjectId = asIdString(data.id);
  const status = asString(data.status)?.toLowerCase() ?? null;
  const amountKobo = isDispute
    ? (parseProviderAmount(data.refund_amount) ??
      (transaction ? parseProviderAmount(transaction.amount) : null))
    : parseProviderAmount(data.amount);
  const currency = asString(data.currency) ?? (transaction ? asString(transaction.currency) : null);

  let occurredAt: string | null = null;
  for (const key of TIMESTAMP_KEYS) {
    const value = asString(data[key]);
    if (value) {
      occurredAt = value;
      break;
    }
  }

  const providerEventId = providerObjectId
    ? `${eventType}:${providerObjectId}:${status ?? ''}`
    : `${eventType}:h:${hashEventIdentity([
        eventType,
        reference,
        refundReference,
        status,
        amountKobo === null ? null : amountKobo.toString(),
        currency,
      ])}`;

  return {
    provider,
    eventType,
    environment: detectDomain(data.domain),
    reference,
    refundReference,
    providerRefundId: isRefund ? providerObjectId : null,
    providerObjectId,
    status,
    amountKobo,
    currency,
    providerEventId,
    occurredAt,
    payload: sanitizeProviderRecord(data),
  };
}
