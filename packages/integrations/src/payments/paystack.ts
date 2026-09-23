import { ProviderError, redactSecrets } from './errors';
import { parseProviderWebhookBody } from './events';
import { sanitizeProviderRecord } from './sanitize';
import { computeWebhookSignature, signatureMatches } from './signature';
import type {
  ConnectionTestResult,
  CreateRefundInput,
  InitializeInput,
  InitializeResult,
  ParsedProviderEvent,
  PaymentEnvironment,
  PaymentProvider,
  RefundResult,
  VerifyResult,
} from './types';
import {
  REFERENCE_PATTERN,
  amountToProviderInteger,
  asIdString,
  asString,
  detectDomain,
  detectKeyEnvironment,
  detectPublicKeyEnvironment,
  isRecord,
  mapRefundStatus,
  mapTransactionStatus,
  parseProviderAmount,
  validateInitializeInput,
} from './validation';

/*
 * Paystack adapter. Everything below was verified against Paystack's official
 * OpenAPI spec and doc-snippet repositories on 2026-09-23 (see
 * docs/providers/research/paystack-termii-research-2026-09-23.md, Part A):
 *   POST /transaction/initialize, GET /transaction/verify/:reference,
 *   POST /refund, GET /refund/:id, header x-paystack-signature (HMAC-SHA512 hex
 *   over the raw body with the secret key), key prefixes sk_test_/sk_live_.
 */

export const PAYSTACK_BASE_URL = 'https://api.paystack.co';

export const PAYSTACK_SIGNATURE_HEADER = 'x-paystack-signature';

/** Webhook origin addresses published by Paystack (optional allow-list; signature check is mandatory). */
export const PAYSTACK_WEBHOOK_IPS = ['52.31.139.75', '52.49.173.169', '52.214.14.220'] as const;

export const PAYSTACK_INLINE_SCRIPT_URL = 'https://js.paystack.co/v2/inline.js';

export const PAYSTACK_DEFAULT_TIMEOUT_MS = 15_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface PaystackProviderOptions {
  /** `sk_test_…` or `sk_live_…`; the prefix decides the environment. */
  secretKey: string;
  /** `pk_test_…` / `pk_live_…`; exposed to the browser for inline checkout only. */
  publicKey?: string | null;
  /** When given, must agree with the key prefix (test and live are never mixed). */
  environment?: PaymentEnvironment;
  fetchImpl?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
  /** Retries for idempotent GETs only (network errors, 429, 5xx). */
  maxRetries?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface RequestOptions {
  retry: boolean;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function providerErrorFromResponse(
  status: number,
  body: unknown,
  secrets: readonly string[],
): ProviderError {
  const record = isRecord(body) ? body : {};
  const providerMessage = asString(record.message) ?? `HTTP ${status}`;
  const providerCode = asString(record.code) ?? undefined;
  const base = { httpStatus: status, providerCode, secrets };
  if (status === 401 || status === 403) {
    return new ProviderError('auth', `Paystack rejected the credentials: ${providerMessage}`, base);
  }
  if (status === 404) return new ProviderError('not_found', providerMessage, base);
  if (status === 429) {
    return new ProviderError('rate_limited', `Paystack rate limit: ${providerMessage}`, {
      ...base,
      retryable: true,
    });
  }
  if (status >= 500) {
    return new ProviderError('provider_error', `Paystack error (${status}): ${providerMessage}`, {
      ...base,
      retryable: true,
    });
  }
  return new ProviderError('invalid_request', providerMessage, base);
}

function toVerifyResult(data: Record<string, unknown>): VerifyResult {
  return {
    providerStatus: mapTransactionStatus(data.status),
    amountKobo: parseProviderAmount(data.amount),
    currency: asString(data.currency),
    providerReference: asString(data.reference),
    providerTransactionId: asIdString(data.id),
    paidAt: asString(data.paid_at) ?? asString(data.paidAt),
    channel: asString(data.channel),
    feesKobo: parseProviderAmount(data.fees),
    gatewayResponse: asString(data.gateway_response),
    environment: detectDomain(data.domain),
    raw: sanitizeProviderRecord(data),
  };
}

function toRefundResult(data: Record<string, unknown>): RefundResult {
  const providerRefundId = asIdString(data.id);
  if (!providerRefundId) {
    throw new ProviderError('provider_error', 'Paystack refund response has no id');
  }
  const transaction = data.transaction;
  const transactionReference = isRecord(transaction)
    ? asString(transaction.reference)
    : asIdString(transaction);
  return {
    providerRefundId,
    status: mapRefundStatus(data.status),
    amountKobo: parseProviderAmount(data.amount),
    currency: asString(data.currency),
    transactionReference,
    raw: sanitizeProviderRecord(data),
  };
}

export class PaystackPaymentProvider implements PaymentProvider {
  readonly id = 'paystack' as const;
  readonly environment: PaymentEnvironment;
  readonly publicKey: string | null;
  private readonly secretKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: PaystackProviderOptions) {
    const secretKey = (options.secretKey ?? '').trim();
    const detected = detectKeyEnvironment(secretKey);
    if (detected === 'unknown') {
      throw new ProviderError(
        'auth',
        'Paystack secret key must start with sk_test_ or sk_live_ (copy it from Dashboard → Settings → API Keys & Webhooks)',
      );
    }
    if (options.environment && options.environment !== detected) {
      throw new ProviderError(
        'invalid_request',
        `configured environment "${options.environment}" does not match the secret key prefix (${detected}); test and live credentials are never mixed`,
      );
    }
    const publicKey = options.publicKey?.trim() || null;
    if (publicKey) {
      const publicEnv = detectPublicKeyEnvironment(publicKey);
      if (publicEnv !== detected) {
        throw new ProviderError(
          'invalid_request',
          `public key prefix (${publicEnv}) does not match the secret key environment (${detected})`,
        );
      }
    }
    this.secretKey = secretKey;
    this.publicKey = publicKey;
    this.environment = detected;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.baseUrl = (options.baseUrl ?? PAYSTACK_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? PAYSTACK_DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 300;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Redacts this provider's secret from any text. */
  redact(text: string): string {
    return redactSecrets(text, [this.secretKey]);
  }

  async initialize(input: InitializeInput): Promise<InitializeResult> {
    validateInitializeInput(input);
    const body: Record<string, unknown> = {
      email: input.email,
      amount: amountToProviderInteger(input.amountKobo),
      currency: input.currency,
      reference: input.reference,
      callback_url: input.callbackUrl,
    };
    if (input.metadata) body.metadata = input.metadata;
    if (input.channels && input.channels.length > 0) body.channels = [...input.channels];

    const response = await this.request('POST', '/transaction/initialize', body, { retry: false });
    const data = this.expectData(response);
    const authorizationUrl = asString(data.authorization_url);
    const accessCode = asString(data.access_code);
    const providerReference = asString(data.reference);
    if (!authorizationUrl || !accessCode || !providerReference) {
      throw new ProviderError(
        'provider_error',
        'Paystack initialize response is missing authorization_url, access_code or reference',
      );
    }
    if (providerReference !== input.reference) {
      throw new ProviderError(
        'provider_error',
        'Paystack returned a different reference than the one requested; attempt not usable',
      );
    }
    if (!authorizationUrl.startsWith('https://')) {
      throw new ProviderError('provider_error', 'Paystack authorization_url is not https');
    }
    return { authorizationUrl, accessCode, providerReference };
  }

  async verify(reference: string): Promise<VerifyResult> {
    if (!REFERENCE_PATTERN.test(reference ?? '')) {
      throw new ProviderError('invalid_request', 'reference contains unsupported characters');
    }
    let response: unknown;
    try {
      response = await this.request(
        'GET',
        `/transaction/verify/${encodeURIComponent(reference)}`,
        undefined,
        { retry: true },
      );
    } catch (error) {
      if (error instanceof ProviderError && error.code === 'not_found') {
        // The provider does not know this reference (yet). Not a settlement
        // and not a failure: the reconciliation job keeps polling until the
        // attempt window closes.
        return {
          providerStatus: 'unknown',
          amountKobo: null,
          currency: null,
          providerReference: null,
          providerTransactionId: null,
          paidAt: null,
          channel: null,
          feesKobo: null,
          gatewayResponse: error.message,
          environment: this.environment,
          raw: { not_found: true, message: error.message },
        };
      }
      throw error;
    }
    return toVerifyResult(this.expectData(response));
  }

  async createRefund(input: CreateRefundInput): Promise<RefundResult> {
    const transaction = asString(input.providerReference) ?? asString(input.reference);
    if (!transaction) {
      throw new ProviderError(
        'invalid_request',
        'a provider reference or attempt reference is required',
      );
    }
    if (!asString(input.idempotencyKey)) {
      throw new ProviderError('invalid_request', 'an idempotency key is required for refunds');
    }
    if (!asString(input.reason)) {
      throw new ProviderError('invalid_request', 'a refund reason is required');
    }
    const body: Record<string, unknown> = {
      transaction,
      customer_note: input.reason.slice(0, 200),
      // Paystack has no idempotency header; the key in the merchant note lets a
      // duplicate be recognised in the dashboard and in GET /refund listings.
      merchant_note: `SimplexD refund ${input.idempotencyKey}: ${input.reason}`.slice(0, 500),
    };
    if (input.amountKobo !== undefined) body.amount = amountToProviderInteger(input.amountKobo);
    if (input.currency) body.currency = input.currency;
    const response = await this.request('POST', '/refund', body, { retry: false });
    return toRefundResult(this.expectData(response));
  }

  async getRefund(providerRefundId: string): Promise<RefundResult> {
    const id = asIdString(providerRefundId);
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new ProviderError('invalid_request', 'refund id contains unsupported characters');
    }
    const response = await this.request('GET', `/refund/${encodeURIComponent(id)}`, undefined, {
      retry: true,
    });
    return toRefundResult(this.expectData(response));
  }

  verifyWebhookSignature(
    rawBody: Buffer | string,
    signatureHeader: string | null | undefined,
  ): boolean {
    return signatureMatches(computeWebhookSignature(rawBody, this.secretKey), signatureHeader);
  }

  parseWebhookEvent(rawBody: Buffer | string): ParsedProviderEvent {
    return parseProviderWebhookBody(rawBody, this.id);
  }

  /**
   * Read-only credential check using only endpoints verified in the research:
   * GET /transaction/verify/<sentinel>. A 404 proves the key was accepted; a
   * 401 proves it was not. Nothing is created or charged.
   */
  async testConnection(): Promise<ConnectionTestResult> {
    const environmentDetected = this.environment;
    const sentinel = `simplexd-connection-check-${Date.now()}`;
    try {
      await this.request('GET', `/transaction/verify/${sentinel}`, undefined, { retry: false });
      return {
        ok: true,
        message: `Paystack accepted the ${environmentDetected} secret key.`,
        environmentDetected,
      };
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      if (error.code === 'not_found') {
        return {
          ok: true,
          message: `Paystack accepted the ${environmentDetected} secret key (sentinel reference correctly reported as not found).`,
          environmentDetected,
        };
      }
      if (error.code === 'auth') {
        return {
          ok: false,
          message: `Paystack rejected the secret key (${error.message}). Check that the ${environmentDetected} key was copied completely and belongs to this business.`,
          environmentDetected,
        };
      }
      return {
        ok: false,
        message: `Could not confirm the Paystack connection: ${error.message}`,
        environmentDetected,
      };
    }
  }

  private expectData(response: unknown): Record<string, unknown> {
    if (!isRecord(response)) {
      throw new ProviderError('provider_error', 'Paystack response was not a JSON object');
    }
    if (response.status !== true) {
      throw new ProviderError(
        'provider_error',
        `Paystack reported failure: ${asString(response.message) ?? 'no message'}`,
        { secrets: [this.secretKey], providerCode: asString(response.code) ?? undefined },
      );
    }
    if (!isRecord(response.data)) {
      throw new ProviderError('provider_error', 'Paystack response has no data object');
    }
    return response.data;
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: Record<string, unknown> | undefined,
    options: RequestOptions,
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const maxAttempts = options.retry ? this.maxRetries + 1 : 1;
    const secrets = [this.secretKey];
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.secretKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        const aborted = controller.signal.aborted;
        const networkError = new ProviderError(
          'network',
          aborted
            ? `Paystack request timed out after ${this.timeoutMs} ms`
            : `Paystack request failed: ${error instanceof Error ? error.message : 'network error'}`,
          { secrets, retryable: true },
        );
        if (attempt < maxAttempts) {
          await this.sleep(this.retryDelayMs * 2 ** (attempt - 1));
          continue;
        }
        throw networkError;
      }
      clearTimeout(timer);

      const text = await response.text();
      let json: unknown = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      if (response.ok) {
        if (json === null) {
          throw new ProviderError('provider_error', 'Paystack returned a non-JSON body', {
            httpStatus: response.status,
            secrets,
          });
        }
        return json;
      }
      const error = providerErrorFromResponse(response.status, json, secrets);
      const canRetry = response.status === 429 || response.status >= 500;
      if (canRetry && attempt < maxAttempts) {
        await this.sleep(this.retryDelayMs * 2 ** (attempt - 1));
        continue;
      }
      throw error;
    }
    throw new ProviderError('network', 'Paystack request was not attempted', { secrets });
  }
}
