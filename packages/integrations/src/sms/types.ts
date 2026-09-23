/**
 * SMS provider contract (brief §13).
 *
 * Termii is the production adapter; `dev` is the labelled development adapter.
 * This package never touches the database: the app and worker persist the
 * typed results below into `delivery_attempts`, `sms_consents`,
 * `suppressions` and `otp_challenges`.
 *
 * Vocabulary:
 * - "accepted" means the provider took the message (HTTP 2xx with a message
 *   id). It is NOT delivery. Delivery is only known from a delivery receipt
 *   (webhook) or a status poll, and is recorded separately.
 * - Every error string returned here is already sanitised: it never contains
 *   the API key, the webhook secret or the raw request body.
 * - An SMS failure never reverses the business transaction that triggered it;
 *   the worker records the failure and retries when `retryable` is true.
 */

export type SmsAdapterId = 'termii' | 'dev';
export type SmsEnvironment = 'test' | 'live';
export type SmsCategory = 'transactional' | 'marketing' | 'security';
export type SmsChannel = 'generic' | 'dnd' | 'whatsapp';
export type SmsDeliveryState = 'delivered' | 'failed' | 'sent' | 'rejected' | 'expired' | 'unknown';
export type SmsWebhookEventType = 'outbound' | 'inbound' | 'device_status' | 'unknown';
export type WebhookHeaders = Record<string, string | string[] | undefined>;

export interface SmsSendInput {
  /** Recipient in E.164 (`+2348012345678`). Normalise with `normalizeToE164` first. */
  to: string;
  /** Approved sender ID (3–11 letters or digits at Termii). */
  from: string;
  body: string;
  category: SmsCategory;
  /** Defaults: transactional/security → `dnd`, marketing → `generic`. */
  channel?: SmsChannel;
  /**
   * Termii `type`. `plain` is verified in the official examples; `unicode` is
   * documented only by third-party mirrors (unverified, see docs/providers/termii.md).
   */
  messageType?: 'plain' | 'unicode';
  /** Stable key for the business event. The worker dedupes on it; the dev adapter does too. */
  idempotencyKey: string;
}

export interface SmsSendResult {
  /** Provider accepted the message for sending. Not delivery. */
  accepted: boolean;
  providerMessageId: string | null;
  providerStatus: string | null;
  /** Wallet balance echoed by the provider after the send, when present. */
  balance?: number | null;
  errorSanitized?: string | null;
  /** Hint for the worker queue: a retry with backoff may succeed. */
  retryable?: boolean;
}

export interface SmsBulkSendInput extends Omit<SmsSendInput, 'to'> {
  to: string[];
}

export interface SmsBulkRecipientResult extends SmsSendResult {
  /** The recipient exactly as supplied in the input (before normalisation). */
  to: string;
}

export interface SmsBalanceResult {
  ok: boolean;
  balance: number | null;
  currency: string | null;
  errorSanitized?: string | null;
}

export type SenderIdApprovalState = 'approved' | 'pending' | 'blocked' | 'unknown';

export interface SenderIdRecord {
  senderId: string;
  /** Raw provider status string (e.g. `active`, `unblock`, `pending`). */
  status: string;
  approval: SenderIdApprovalState;
  company: string | null;
  useCase: string | null;
  country: string | null;
  createdAt: string | null;
}

export interface SenderIdListResult {
  ok: boolean;
  senderIds: SenderIdRecord[];
  errorSanitized?: string | null;
}

export interface SenderIdRequestInput {
  senderId: string;
  useCase: string;
  company: string;
}

export interface SenderIdRequestResult {
  ok: boolean;
  message: string | null;
  errorSanitized?: string | null;
}

export interface SmsMessageStatus {
  found: boolean;
  providerMessageId: string;
  deliveryState: SmsDeliveryState;
  providerStatus: string | null;
  recipient: string | null;
  /** Provider-reported cost in the provider's currency units, when present. */
  cost: number | null;
  occurredAt: Date | null;
  errorSanitized?: string | null;
}

export interface SmsDeliveryWebhookEvent {
  type: SmsWebhookEventType;
  providerMessageId: string | null;
  /** E.164 when the payload number could be normalised, otherwise the raw value. */
  recipient: string | null;
  deliveryState: SmsDeliveryState;
  /** Raw provider status string, e.g. `DELIVERED | Message delivered to handset`. */
  providerStatus: string | null;
  occurredAt: Date | null;
  /** Inbound only: who sent the message (E.164 when parseable) and the text, for STOP handling. */
  sender?: string | null;
  inboundText?: string | null;
  channel?: string | null;
  /** `unchecked` when the adapter has no webhook secret configured. */
  signature: 'valid' | 'invalid' | 'unchecked';
}

export interface SmsConnectionTestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
  balance?: number | null;
  currency?: string | null;
  senderIdApproval?: SenderIdApprovalState | 'not_registered' | null;
}

export interface SmsProviderDescription {
  adapter: SmsAdapterId;
  environment: SmsEnvironment;
  baseUrl: string | null;
  senderId: string | null;
  /** Masked presence only; the key itself is never exposed. */
  apiKeyMasked: string;
  webhookSecretConfigured: boolean;
}

/**
 * Optional provider-managed OTP (Termii Token API). SimplexD does not use it
 * for staff MFA (authenticator apps are preferred, brief §13); it exists for
 * customer phone verification flows that explicitly opt in.
 */
export interface ProviderOtpSendInput {
  to: string;
  from: string;
  channel?: SmsChannel;
  pinLength?: number;
  ttlMinutes?: number;
  maxAttempts?: number;
  /** Message text containing the placeholder, e.g. `Your SimplexD code is < 1234 >`. */
  messageText?: string;
  placeholder?: string;
}

export interface ProviderOtpSendResult {
  ok: boolean;
  pinId: string | null;
  providerStatus: string | null;
  errorSanitized?: string | null;
}

export interface ProviderOtpVerifyResult {
  ok: boolean;
  status: 'verified' | 'expired' | 'invalid' | 'error';
  errorSanitized?: string | null;
}

export interface SmsProvider {
  readonly id: SmsAdapterId;
  readonly environment: SmsEnvironment;
  send(input: SmsSendInput): Promise<SmsSendResult>;
  /** Chunks recipients (100 per Termii request) and returns one result per input recipient. */
  sendBulk(input: SmsBulkSendInput): Promise<SmsBulkRecipientResult[]>;
  getBalance(): Promise<SmsBalanceResult>;
  listSenderIds(): Promise<SenderIdListResult>;
  requestSenderId(input: SenderIdRequestInput): Promise<SenderIdRequestResult>;
  getMessageStatus(providerMessageId: string): Promise<SmsMessageStatus>;
  /** Parses a delivery-report/inbound webhook. Callers must reject events whose `signature` is not `valid` in production. */
  parseDeliveryWebhook(rawBody: string | Buffer, headers: WebhookHeaders): SmsDeliveryWebhookEvent;
  verifyWebhookSignature(
    rawBody: string | Buffer,
    header: string | string[] | null | undefined,
    secret: string,
  ): boolean;
  testConnection(): Promise<SmsConnectionTestResult>;
  describe(): SmsProviderDescription;
  sendProviderOtp?(input: ProviderOtpSendInput): Promise<ProviderOtpSendResult>;
  verifyProviderOtp?(pinId: string, pin: string): Promise<ProviderOtpVerifyResult>;
}
