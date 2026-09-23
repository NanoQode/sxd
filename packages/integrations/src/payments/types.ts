/**
 * Payment provider contract (build brief §12).
 *
 * Rules the contract encodes:
 * - Hosted checkout only: the adapter hands back an authorization URL / access
 *   code; card details never touch SimplexD servers.
 * - Payment attempts are created server-side from an authorised invoice with an
 *   immutable amount (integer kobo as bigint), currency and reference.
 * - A browser redirect is not settlement. `verify()` is pure transport; the
 *   matching of status, reference, amount and currency happens in
 *   `matchVerification` and the allocation happens in the application layer
 *   inside a transaction keyed by the allocation dedupe key.
 * - Webhooks are authenticated with HMAC-SHA512 over the exact raw body and
 *   parsed into a `ParsedProviderEvent` carrying a stable id for deduplication.
 */

export type PaymentProviderId = 'paystack' | 'dev';

export type PaymentEnvironment = 'test' | 'live';

export type DetectedEnvironment = PaymentEnvironment | 'unknown';

/** Paystack channel names (OpenAPI `TransactionInitialize.channels` enum, verified 2026-09-23). */
export const PAYMENT_CHANNELS = [
  'apple_pay',
  'bank',
  'bank_transfer',
  'capitec_pay',
  'card',
  'eft',
  'mobile_money',
  'payattitude',
  'qr',
  'ussd',
] as const;

export type PaymentChannel = (typeof PAYMENT_CHANNELS)[number];

/** Currencies the provider accepts (OpenAPI `Currency` enum, verified 2026-09-23). NGN is the platform default. */
export const PROVIDER_CURRENCIES = ['NGN', 'GHS', 'KES', 'ZAR', 'USD'] as const;

export type ProviderCurrency = (typeof PROVIDER_CURRENCIES)[number];

export interface InitializeInput {
  /** Our immutable payment-attempt reference (only `-`, `.`, `=` and alphanumerics). */
  reference: string;
  /** Integer kobo. Never floating point. */
  amountKobo: bigint;
  currency: string;
  email: string;
  /** Absolute URL the customer is redirected to after checkout. Visiting it is not settlement. */
  callbackUrl: string;
  metadata?: Record<string, unknown>;
  channels?: readonly PaymentChannel[];
}

export interface InitializeResult {
  /** Hosted checkout page. */
  authorizationUrl: string;
  /** For `PaystackPop.resumeTransaction(accessCode)` on the client. */
  accessCode: string;
  /** The reference the provider stored; equals `InitializeInput.reference` for Paystack. */
  providerReference: string;
}

export type ProviderTransactionStatus =
  | 'success'
  | 'failed'
  | 'abandoned'
  | 'reversed'
  | 'pending'
  | 'unknown';

export interface VerifyResult {
  providerStatus: ProviderTransactionStatus;
  /** Integer subunit as reported by the provider; null when absent. */
  amountKobo: bigint | null;
  currency: string | null;
  providerReference: string | null;
  /** Provider's numeric transaction id, as a string. */
  providerTransactionId: string | null;
  paidAt: string | null;
  channel: string | null;
  feesKobo: bigint | null;
  gatewayResponse: string | null;
  /** `data.domain` on Paystack responses. */
  environment: DetectedEnvironment;
  /** Provider payload with card tokens, signatures, IPs and logs removed. Safe to persist. */
  raw: Record<string, unknown>;
}

export type ProviderRefundStatus =
  | 'pending'
  | 'processing'
  | 'processed'
  | 'failed'
  | 'needs_attention';

export interface CreateRefundInput {
  /** Provider transaction reference or id (preferred). */
  providerReference?: string | null;
  /** Our attempt reference (Paystack accepts it in `transaction`). */
  reference?: string | null;
  /** Partial refund amount in kobo; omit for a full refund. */
  amountKobo?: bigint;
  currency?: string;
  /** Shown to the customer as the refund reason. Never include secrets or internal notes. */
  reason: string;
  /**
   * Application-generated key stored on the refund record before the provider
   * call. The application must never call `createRefund` twice for one key.
   */
  idempotencyKey: string;
}

export interface RefundResult {
  providerRefundId: string;
  status: ProviderRefundStatus;
  amountKobo: bigint | null;
  currency: string | null;
  transactionReference: string | null;
  raw: Record<string, unknown>;
}

export interface ParsedProviderEvent {
  provider: PaymentProviderId;
  /** e.g. `charge.success`, `refund.processed`, `charge.dispute.create`. */
  eventType: string;
  /** `data.domain` of the event; test and live events are never mixed. */
  environment: DetectedEnvironment;
  /** Payment-attempt reference the event concerns, when it carries one. */
  reference: string | null;
  /** `data.refund_reference` on refund events. */
  refundReference: string | null;
  /** Provider refund id (`data.id` on refund events), when present. */
  providerRefundId: string | null;
  /** `data.id` of the object the event describes (transaction, dispute, transfer). */
  providerObjectId: string | null;
  /** `data.status` verbatim (lower-cased). */
  status: string | null;
  amountKobo: bigint | null;
  currency: string | null;
  /**
   * Stable identifier for deduplication: built from the object id when the
   * payload has one, otherwise a hash of event + reference + status + amount.
   * Replays of the same event produce the same id; a later state produces a
   * different one.
   */
  providerEventId: string;
  occurredAt: string | null;
  /** Sanitized `data` object (see `sanitizeProviderRecord`). */
  payload: Record<string, unknown>;
}

export interface ConnectionTestResult {
  ok: boolean;
  /** Human-readable, never contains the secret. */
  message: string;
  environmentDetected: DetectedEnvironment;
}

export interface PaymentProvider {
  readonly id: PaymentProviderId;
  readonly environment: PaymentEnvironment;
  initialize(input: InitializeInput): Promise<InitializeResult>;
  /** Pure transport: returns what the provider says. Match with `matchVerification`. */
  verify(reference: string): Promise<VerifyResult>;
  createRefund(input: CreateRefundInput): Promise<RefundResult>;
  getRefund(providerRefundId: string): Promise<RefundResult>;
  /** Constant-time HMAC-SHA512 check over the exact raw body. */
  verifyWebhookSignature(
    rawBody: Buffer | string,
    signatureHeader: string | null | undefined,
  ): boolean;
  /** Parses an authenticated raw body. Throws `ProviderError('invalid_request')` on malformed input. */
  parseWebhookEvent(rawBody: Buffer | string): ParsedProviderEvent;
  /** Read-only check that the credentials are accepted. Save ≠ test ≠ activate. */
  testConnection(): Promise<ConnectionTestResult>;
}
