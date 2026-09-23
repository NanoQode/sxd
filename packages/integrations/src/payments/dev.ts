import { randomBytes } from 'node:crypto';
import { bpsOf } from '@simplexd/domain/money';
import { ProviderError } from './errors';
import { parseProviderWebhookBody } from './events';
import { computeWebhookSignature, signatureMatches } from './signature';
import type {
  ConnectionTestResult,
  CreateRefundInput,
  InitializeInput,
  InitializeResult,
  ParsedProviderEvent,
  PaymentEnvironment,
  PaymentProvider,
  ProviderRefundStatus,
  ProviderTransactionStatus,
  RefundResult,
  VerifyResult,
} from './types';
import { amountToProviderInteger, asString, validateInitializeInput } from './validation';

/**
 * DEVELOPMENT ADAPTER — not a real gateway.
 *
 * Simulates the Paystack contract in memory so the checkout, verification,
 * webhook and refund journeys can be exercised locally without credentials.
 * It refuses to exist in production or in a "live" environment. Outcomes are
 * chosen explicitly with `simulate()` / `simulateRefund()`; nothing settles by
 * itself, so a redirect is still not a settlement here either.
 */

export const DEV_ADAPTER_LABEL = 'development adapter, not a real gateway';

export const DEV_CHECKOUT_PATH = '/dev/paystack-checkout';

export const DEV_WEBHOOK_SECRET_DEFAULT = 'sk_test_development_adapter_webhook_secret';

export type DevOutcome = ProviderTransactionStatus;

export interface DevSimulationOverrides {
  amountKobo?: bigint;
  currency?: string;
  channel?: string;
  feesKobo?: bigint | null;
  gatewayResponse?: string;
}

interface DevAttempt {
  reference: string;
  amountKobo: bigint;
  currency: string;
  email: string;
  accessCode: string;
  status: DevOutcome;
  channel: string | null;
  feesKobo: bigint | null;
  gatewayResponse: string | null;
  paidAt: string | null;
  createdAt: string;
  transactionId: string;
  overrides: DevSimulationOverrides;
}

interface DevRefund {
  id: string;
  transactionReference: string;
  amountKobo: bigint;
  currency: string;
  status: ProviderRefundStatus;
  idempotencyKey: string;
  reason: string;
}

export interface DevPaymentProviderOptions {
  /** Public origin of the app, e.g. http://localhost:3000. */
  appUrl: string;
  environment?: PaymentEnvironment;
  /** Secret used to sign simulated webhooks. */
  webhookSecret?: string;
  /** Overrides process.env.APP_ENV (tests). */
  appEnv?: string;
  now?: () => Date;
}

export type DevWebhookEventType =
  | 'charge.success'
  | 'refund.pending'
  | 'refund.processing'
  | 'refund.processed'
  | 'refund.failed'
  | 'refund.needs-attention'
  | 'charge.dispute.create';

export interface DevWebhookDelivery {
  rawBody: string;
  signature: string;
  headers: Record<string, string>;
}

export class DevPaymentProvider implements PaymentProvider {
  readonly id = 'dev' as const;
  readonly environment = 'test' as const;
  readonly label = DEV_ADAPTER_LABEL;
  private readonly appUrl: string;
  private readonly webhookSecret: string;
  private readonly now: () => Date;
  private readonly attempts = new Map<string, DevAttempt>();
  private readonly refunds = new Map<string, DevRefund>();
  private refundCounter = 0;
  private transactionCounter = 1000;

  constructor(options: DevPaymentProviderOptions) {
    const appEnv = options.appEnv ?? process.env.APP_ENV;
    if (appEnv === 'production') {
      throw new Error(
        'DevPaymentProvider is a development adapter and cannot run when APP_ENV=production',
      );
    }
    if (options.environment === 'live') {
      throw new Error('DevPaymentProvider cannot be constructed for the live environment');
    }
    let origin: URL;
    try {
      origin = new URL(options.appUrl);
    } catch {
      throw new Error('DevPaymentProvider requires an absolute appUrl');
    }
    this.appUrl = origin.origin;
    this.webhookSecret = options.webhookSecret ?? DEV_WEBHOOK_SECRET_DEFAULT;
    this.now = options.now ?? (() => new Date());
  }

  async initialize(input: InitializeInput): Promise<InitializeResult> {
    validateInitializeInput(input);
    if (this.attempts.has(input.reference)) {
      throw new ProviderError('invalid_request', 'Duplicate Transaction Reference', {
        httpStatus: 400,
        providerCode: 'duplicate_reference',
      });
    }
    const accessCode = `dev_${randomBytes(6).toString('hex')}`;
    this.transactionCounter += 1;
    this.attempts.set(input.reference, {
      reference: input.reference,
      amountKobo: input.amountKobo,
      currency: input.currency,
      email: input.email,
      accessCode,
      status: 'pending',
      channel: null,
      feesKobo: null,
      gatewayResponse: null,
      paidAt: null,
      createdAt: this.now().toISOString(),
      transactionId: String(this.transactionCounter),
      overrides: {},
    });
    const url = new URL(DEV_CHECKOUT_PATH, this.appUrl);
    url.searchParams.set('reference', input.reference);
    return { authorizationUrl: url.toString(), accessCode, providerReference: input.reference };
  }

  /**
   * Chooses the outcome `verify()` will report. Overrides let tests simulate a
   * provider reporting a different amount or currency than the attempt.
   */
  simulate(
    reference: string,
    outcome: DevOutcome,
    overrides: DevSimulationOverrides = {},
  ): VerifyResult {
    const attempt = this.attempts.get(reference);
    if (!attempt) {
      throw new ProviderError('not_found', 'Transaction reference not found', { httpStatus: 404 });
    }
    attempt.status = outcome;
    attempt.overrides = overrides;
    attempt.channel = overrides.channel ?? (outcome === 'success' ? 'card' : attempt.channel);
    attempt.gatewayResponse =
      overrides.gatewayResponse ??
      (outcome === 'success' ? 'Approved' : outcome === 'failed' ? 'Declined' : null);
    attempt.paidAt = outcome === 'success' ? this.now().toISOString() : null;
    if (outcome === 'success') {
      attempt.feesKobo =
        overrides.feesKobo === undefined
          ? simulatedFees(overrides.amountKobo ?? attempt.amountKobo)
          : overrides.feesKobo;
    } else {
      attempt.feesKobo = null;
    }
    return this.toVerifyResult(attempt);
  }

  async verify(reference: string): Promise<VerifyResult> {
    const attempt = this.attempts.get(reference);
    if (!attempt) {
      return {
        providerStatus: 'unknown',
        amountKobo: null,
        currency: null,
        providerReference: null,
        providerTransactionId: null,
        paidAt: null,
        channel: null,
        feesKobo: null,
        gatewayResponse: 'Transaction reference not found',
        environment: 'test',
        raw: { not_found: true, adapter: DEV_ADAPTER_LABEL },
      };
    }
    return this.toVerifyResult(attempt);
  }

  async createRefund(input: CreateRefundInput): Promise<RefundResult> {
    const reference = asString(input.providerReference) ?? asString(input.reference);
    if (!reference) {
      throw new ProviderError(
        'invalid_request',
        'a provider reference or attempt reference is required',
      );
    }
    if (!asString(input.idempotencyKey)) {
      throw new ProviderError('invalid_request', 'an idempotency key is required for refunds');
    }
    for (const refund of this.refunds.values()) {
      if (refund.idempotencyKey === input.idempotencyKey) return this.toRefundResult(refund);
    }
    const attempt = this.attempts.get(reference);
    if (!attempt) {
      throw new ProviderError('not_found', 'Transaction reference not found', { httpStatus: 404 });
    }
    if (attempt.status !== 'success') {
      throw new ProviderError(
        'invalid_request',
        'Transaction was not successful; nothing to refund',
        {
          httpStatus: 400,
        },
      );
    }
    const amountKobo = input.amountKobo ?? attempt.amountKobo;
    amountToProviderInteger(amountKobo);
    if (amountKobo > attempt.amountKobo) {
      throw new ProviderError(
        'invalid_request',
        'Refund amount cannot be more than the original transaction amount',
        {
          httpStatus: 400,
        },
      );
    }
    this.refundCounter += 1;
    const refund: DevRefund = {
      id: String(3_000_000 + this.refundCounter),
      transactionReference: reference,
      amountKobo,
      currency: input.currency ?? attempt.currency,
      status: 'pending',
      idempotencyKey: input.idempotencyKey,
      reason: input.reason,
    };
    this.refunds.set(refund.id, refund);
    return this.toRefundResult(refund);
  }

  /** Moves a simulated refund to a provider status (pending → processing → processed/failed/needs_attention). */
  simulateRefund(providerRefundId: string, status: ProviderRefundStatus): RefundResult {
    const refund = this.refunds.get(providerRefundId);
    if (!refund) throw new ProviderError('not_found', 'Refund not found', { httpStatus: 404 });
    refund.status = status;
    return this.toRefundResult(refund);
  }

  async getRefund(providerRefundId: string): Promise<RefundResult> {
    const refund = this.refunds.get(providerRefundId);
    if (!refund) throw new ProviderError('not_found', 'Refund not found', { httpStatus: 404 });
    return this.toRefundResult(refund);
  }

  verifyWebhookSignature(
    rawBody: Buffer | string,
    signatureHeader: string | null | undefined,
  ): boolean {
    return signatureMatches(computeWebhookSignature(rawBody, this.webhookSecret), signatureHeader);
  }

  parseWebhookEvent(rawBody: Buffer | string): ParsedProviderEvent {
    return parseProviderWebhookBody(rawBody, this.id);
  }

  async testConnection(): Promise<ConnectionTestResult> {
    return { ok: true, message: DEV_ADAPTER_LABEL, environmentDetected: 'test' };
  }

  /** Signs an arbitrary raw body with the dev webhook secret. */
  signWebhook(rawBody: Buffer | string): string {
    return computeWebhookSignature(rawBody, this.webhookSecret);
  }

  /**
   * Builds a Paystack-shaped webhook delivery for a simulated attempt or
   * refund so the local checkout page can POST it to our webhook route.
   */
  buildWebhookEvent(
    eventType: DevWebhookEventType,
    reference: string,
    options: { providerRefundId?: string } = {},
  ): DevWebhookDelivery {
    const attempt = this.attempts.get(reference);
    if (!attempt) {
      throw new ProviderError('not_found', 'Transaction reference not found', { httpStatus: 404 });
    }
    let data: Record<string, unknown>;
    if (eventType === 'charge.success') {
      const verified = this.toVerifyResult(attempt);
      data = {
        id: Number(attempt.transactionId),
        domain: 'test',
        status: verified.providerStatus,
        reference: attempt.reference,
        amount: Number(verified.amountKobo ?? attempt.amountKobo),
        message: null,
        gateway_response: verified.gatewayResponse,
        paid_at: verified.paidAt,
        created_at: attempt.createdAt,
        channel: verified.channel,
        currency: verified.currency,
        fees: verified.feesKobo === null ? null : Number(verified.feesKobo),
        customer: { email: attempt.email },
        metadata: { adapter: DEV_ADAPTER_LABEL },
      };
    } else if (eventType === 'charge.dispute.create') {
      data = {
        id: Number(attempt.transactionId) + 500_000,
        refund_amount: Number(attempt.amountKobo),
        currency: attempt.currency,
        status: 'awaiting-merchant-feedback',
        resolution: null,
        domain: 'test',
        transaction: {
          id: Number(attempt.transactionId),
          reference: attempt.reference,
          amount: Number(attempt.amountKobo),
          status: 'success',
          currency: attempt.currency,
        },
        category: 'chargeback',
        customer: { email: attempt.email },
        dueAt: new Date(this.now().getTime() + 48 * 3600 * 1000).toISOString(),
        resolvedAt: null,
        created_at: this.now().toISOString(),
        updated_at: this.now().toISOString(),
      };
    } else {
      const refund = options.providerRefundId
        ? this.refunds.get(options.providerRefundId)
        : [...this.refunds.values()].find((r) => r.transactionReference === reference);
      if (!refund) throw new ProviderError('not_found', 'Refund not found', { httpStatus: 404 });
      const status = eventType.slice('refund.'.length);
      data = {
        status,
        transaction_reference: refund.transactionReference,
        refund_reference: status === 'pending' ? null : `TRF_dev_${refund.id}`,
        amount: Number(refund.amountKobo),
        currency: refund.currency,
        processor: 'development-adapter',
        customer: { email: attempt.email },
        integration: 0,
        domain: 'test',
        id: refund.id,
        customer_note: refund.reason,
      };
    }
    const rawBody = JSON.stringify({ event: eventType, data });
    const signature = this.signWebhook(rawBody);
    return {
      rawBody,
      signature,
      headers: { 'content-type': 'application/json', 'x-paystack-signature': signature },
    };
  }

  private toVerifyResult(attempt: DevAttempt): VerifyResult {
    const overrides = attempt.overrides;
    const amountKobo = overrides.amountKobo ?? attempt.amountKobo;
    const currency = overrides.currency ?? attempt.currency;
    return {
      providerStatus: attempt.status,
      amountKobo,
      currency,
      providerReference: attempt.reference,
      providerTransactionId: attempt.transactionId,
      paidAt: attempt.paidAt,
      channel: attempt.channel,
      feesKobo: attempt.feesKobo,
      gatewayResponse: attempt.gatewayResponse,
      environment: 'test',
      raw: {
        adapter: DEV_ADAPTER_LABEL,
        id: Number(attempt.transactionId),
        domain: 'test',
        status: attempt.status,
        reference: attempt.reference,
        amount: Number(amountKobo),
        currency,
        channel: attempt.channel,
        paid_at: attempt.paidAt,
        created_at: attempt.createdAt,
        fees: attempt.feesKobo === null ? null : Number(attempt.feesKobo),
        customer: { email: attempt.email },
      },
    };
  }

  private toRefundResult(refund: DevRefund): RefundResult {
    return {
      providerRefundId: refund.id,
      status: refund.status,
      amountKobo: refund.amountKobo,
      currency: refund.currency,
      transactionReference: refund.transactionReference,
      raw: {
        adapter: DEV_ADAPTER_LABEL,
        id: Number(refund.id),
        status: refund.status,
        amount: Number(refund.amountKobo),
        currency: refund.currency,
        transaction: { reference: refund.transactionReference },
        merchant_note: `SimplexD refund ${refund.idempotencyKey}: ${refund.reason}`,
      },
    };
  }
}

/** Rough local-card fee shape (1.5%, capped) so fee postings get exercised. Not Paystack's real schedule. */
function simulatedFees(amountKobo: bigint): bigint {
  const fee = bpsOf(amountKobo, 150);
  return fee > 200_000n ? 200_000n : fee;
}
