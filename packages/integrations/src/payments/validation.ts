import { ProviderError } from './errors';
import {
  PAYMENT_CHANNELS,
  PROVIDER_CURRENCIES,
  type DetectedEnvironment,
  type InitializeInput,
  type ProviderRefundStatus,
  type ProviderTransactionStatus,
} from './types';

/** Paystack: "Unique transaction reference. Only -, ., = and alphanumeric characters allowed." */
export const REFERENCE_PATTERN = /^[A-Za-z0-9.=-]{1,100}$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Ids arrive as numbers or strings; keep them as strings so large ids never lose precision. */
export function asIdString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return null;
}

/**
 * Provider amounts are integer subunits but arrive as numbers or, in some
 * webhook samples, as numeric strings. Anything else (floats, negatives,
 * blanks) is treated as absent rather than guessed.
 */
export function parseProviderAmount(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return /^\d+$/.test(trimmed) ? BigInt(trimmed) : null;
  }
  return null;
}

/** Converts kobo to the integer the provider expects; refuses unsafe or non-positive values. */
export function amountToProviderInteger(amountKobo: bigint): number {
  if (typeof amountKobo !== 'bigint') {
    throw new ProviderError('invalid_request', 'amountKobo must be a bigint of integer kobo');
  }
  if (amountKobo <= 0n) throw new ProviderError('invalid_request', 'amountKobo must be positive');
  if (amountKobo > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ProviderError('invalid_request', 'amountKobo exceeds the provider integer range');
  }
  return Number(amountKobo);
}

export function validateInitializeInput(input: InitializeInput): void {
  if (!REFERENCE_PATTERN.test(input.reference ?? '')) {
    throw new ProviderError(
      'invalid_request',
      'reference may only contain letters, digits, "-", "." and "=" (max 100 characters)',
    );
  }
  amountToProviderInteger(input.amountKobo);
  if (!PROVIDER_CURRENCIES.includes(input.currency as (typeof PROVIDER_CURRENCIES)[number])) {
    throw new ProviderError(
      'invalid_request',
      `currency ${String(input.currency)} is not supported by the provider`,
    );
  }
  if (typeof input.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
    throw new ProviderError('invalid_request', 'a valid customer email is required');
  }
  let callback: URL;
  try {
    callback = new URL(input.callbackUrl);
  } catch {
    throw new ProviderError('invalid_request', 'callbackUrl must be an absolute URL');
  }
  if (callback.protocol !== 'https:' && callback.protocol !== 'http:') {
    throw new ProviderError('invalid_request', 'callbackUrl must use http(s)');
  }
  if (input.channels) {
    for (const channel of input.channels) {
      if (!PAYMENT_CHANNELS.includes(channel)) {
        throw new ProviderError('invalid_request', `unsupported payment channel ${String(channel)}`);
      }
    }
  }
}

export function detectKeyEnvironment(secretKey: string | null | undefined): DetectedEnvironment {
  if (!secretKey) return 'unknown';
  if (secretKey.startsWith('sk_test_')) return 'test';
  if (secretKey.startsWith('sk_live_')) return 'live';
  return 'unknown';
}

export function detectPublicKeyEnvironment(publicKey: string | null | undefined): DetectedEnvironment {
  if (!publicKey) return 'unknown';
  if (publicKey.startsWith('pk_test_')) return 'test';
  if (publicKey.startsWith('pk_live_')) return 'live';
  return 'unknown';
}

/**
 * Paystack transaction statuses seen in the OpenAPI spec: success, failed,
 * abandoned, reversed. In-flight values map to `pending`; anything else is
 * `unknown` and never settles.
 */
export function mapTransactionStatus(raw: unknown): ProviderTransactionStatus {
  const status = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  switch (status) {
    case 'success':
      return 'success';
    case 'failed':
      return 'failed';
    case 'abandoned':
      return 'abandoned';
    case 'reversed':
      return 'reversed';
    case 'ongoing':
    case 'pending':
    case 'processing':
    case 'queued':
      return 'pending';
    default:
      return 'unknown';
  }
}

/** Refund statuses: pending, processing, processed, failed, needs-attention. Unknown values need a human. */
export function mapRefundStatus(raw: unknown): ProviderRefundStatus {
  const status = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  switch (status) {
    case 'pending':
      return 'pending';
    case 'processing':
      return 'processing';
    case 'processed':
      return 'processed';
    case 'failed':
      return 'failed';
    case 'needs-attention':
    case 'needs_attention':
      return 'needs_attention';
    default:
      return 'needs_attention';
  }
}

export function detectDomain(value: unknown): DetectedEnvironment {
  if (value === 'test' || value === 'live') return value;
  return 'unknown';
}
