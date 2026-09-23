export type ProviderErrorCode =
  'auth' | 'network' | 'invalid_request' | 'not_found' | 'rate_limited' | 'provider_error';

const KEY_PATTERN = /\b[sp]k_(?:test|live)_[A-Za-z0-9]+/g;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._-]+/gi;

/**
 * Removes configured secrets and anything that looks like a Paystack key or a
 * bearer token from free text before it is logged, stored or shown.
 */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  return out.replace(KEY_PATTERN, '[redacted-key]').replace(BEARER_PATTERN, 'Bearer [redacted]');
}

const CUSTOMER_MESSAGES: Record<ProviderErrorCode, string> = {
  auth: 'The payment service is not configured correctly. Please try again later or contact support.',
  network: 'We could not reach the payment service. Please try again in a moment.',
  invalid_request:
    'The payment request was not accepted. Please try again or contact support with your reference.',
  not_found:
    'The payment could not be found. If you were charged, contact support with your payment reference.',
  rate_limited: 'The payment service is busy. Please try again in a moment.',
  provider_error: 'The payment service reported a problem. Please try again later.',
};

export interface ProviderErrorOptions {
  httpStatus?: number;
  /** Provider error code such as `duplicate_reference`. */
  providerCode?: string;
  retryable?: boolean;
  /** Secrets to strip from the message. */
  secrets?: readonly string[];
}

/**
 * Sanitized provider failure. The `message` is safe for operator logs and the
 * admin console; `customerMessage` is safe for customers. Neither ever
 * contains the secret key.
 */
export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  readonly code: ProviderErrorCode;
  readonly httpStatus: number | null;
  readonly providerCode: string | null;
  readonly retryable: boolean;

  constructor(code: ProviderErrorCode, message: string, options: ProviderErrorOptions = {}) {
    super(redactSecrets(message, options.secrets));
    this.code = code;
    this.httpStatus = options.httpStatus ?? null;
    this.providerCode = options.providerCode
      ? redactSecrets(options.providerCode, options.secrets)
      : null;
    this.retryable = options.retryable ?? (code === 'network' || code === 'rate_limited');
  }

  get customerMessage(): string {
    return CUSTOMER_MESSAGES[this.code];
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      httpStatus: this.httpStatus,
      providerCode: this.providerCode,
      retryable: this.retryable,
    };
  }
}

export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
}
