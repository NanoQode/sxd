/**
 * Stable API error codes and the response envelope. Every error response
 * carries a correlation id so support can match logs, and `retryable` tells
 * clients whether a retry can help.
 */

export const ERROR_CODES = [
  'validation_failed',
  'unauthenticated',
  'forbidden',
  'mfa_required',
  'not_found',
  'conflict',
  'version_conflict',
  'idempotency_conflict',
  'rate_limited',
  'invalid_transition',
  'deadline_passed',
  'payment_verification_failed',
  'provider_unavailable',
  'provider_not_configured',
  'feature_disabled',
  'file_rejected',
  'file_quarantined',
  'slot_unavailable',
  'insufficient_evidence',
  'internal_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    correlationId: string;
    details?: unknown;
    retryable?: boolean;
    retryAfterSeconds?: number;
  };
}

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  mfa_required: 403,
  not_found: 404,
  conflict: 409,
  version_conflict: 409,
  idempotency_conflict: 409,
  rate_limited: 429,
  invalid_transition: 409,
  deadline_passed: 409,
  payment_verification_failed: 402,
  provider_unavailable: 503,
  provider_not_configured: 503,
  feature_disabled: 404,
  file_rejected: 422,
  file_quarantined: 423,
  slot_unavailable: 409,
  insufficient_evidence: 422,
  internal_error: 500,
};

export function statusForCode(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      details?: unknown;
      retryable?: boolean;
      retryAfterSeconds?: number;
      status?: number;
    } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = options.status ?? statusForCode(code);
    this.details = options.details;
    this.retryable =
      options.retryable ?? (code === 'rate_limited' || code === 'provider_unavailable');
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  toBody(correlationId: string): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        correlationId,
        ...(this.details !== undefined ? { details: this.details } : {}),
        retryable: this.retryable,
        ...(this.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: this.retryAfterSeconds }
          : {}),
      },
    };
  }
}

export const notFound = (what = 'resource') => new ApiError('not_found', `${what} not found`);
export const forbidden = (message = 'you do not have access to this resource') =>
  new ApiError('forbidden', message);
export const unauthenticated = () => new ApiError('unauthenticated', 'sign in required');
