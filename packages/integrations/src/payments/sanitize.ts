/**
 * Strips card tokens, signatures, network and log details from provider
 * payloads before they are persisted (`payment_attempts.provider_response_sanitized`,
 * `provider_events.headers_sanitized`) or shown in the admin console. The exact
 * raw webhook body is stored separately for signature re-verification.
 */

const DROP_KEYS = new Set([
  'authorization_code',
  'signature',
  'bin',
  'exp_month',
  'exp_year',
  'ip_address',
  'log',
  'phone',
  'international_format_phone',
  'account_number',
]);

const SENSITIVE_KEY_PATTERN = /(secret|token|password|api_key|apikey|private_key|otp|pin)$/i;

const MAX_DEPTH = 8;
const MAX_STRING = 1000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sanitizeProviderValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((item) => sanitizeProviderValue(item, depth + 1));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (DROP_KEYS.has(key) || SENSITIVE_KEY_PATTERN.test(key)) continue;
      out[key] = sanitizeProviderValue(item, depth + 1);
    }
    return out;
  }
  return undefined;
}

export function sanitizeProviderRecord(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeProviderValue(value);
  return isPlainObject(sanitized) ? sanitized : {};
}

/** Request headers safe to store next to a provider event (no cookies, no auth). */
export function sanitizeHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const allowed = [
    'content-type',
    'content-length',
    'user-agent',
    'x-paystack-signature',
    'x-forwarded-for',
    'x-real-ip',
  ];
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (!allowed.includes(lower) || value === undefined) continue;
    const text = Array.isArray(value) ? value.join(', ') : value;
    out[lower] = lower === 'x-paystack-signature' ? `${text.slice(0, 8)}…` : text.slice(0, 200);
  }
  return out;
}
