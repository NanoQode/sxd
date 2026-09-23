import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Paystack signs every webhook with `x-paystack-signature` = hex(HMAC-SHA512(raw body, secret key)).
 * The HMAC must be computed over the exact bytes received, never over a re-serialised JSON object.
 */
export function computeWebhookSignature(rawBody: Buffer | string, secret: string): string {
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  return createHmac('sha512', secret).update(body).digest('hex');
}

/**
 * Constant-time comparison of a hex signature header against the expected hex
 * digest. Rejects missing, non-hex and length-mismatched values before the
 * timing-safe comparison (which requires equal-length buffers).
 */
export function signatureMatches(
  expectedHex: string,
  signatureHeader: string | null | undefined,
): boolean {
  if (!signatureHeader) return false;
  const provided = signatureHeader.trim().toLowerCase();
  if (provided.length !== expectedHex.length) return false;
  if (!/^[0-9a-f]+$/.test(provided)) return false;
  const a = Buffer.from(expectedHex, 'hex');
  const b = Buffer.from(provided, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function verifyHmacSha512Signature(
  rawBody: Buffer | string,
  secret: string,
  signatureHeader: string | null | undefined,
): boolean {
  if (!secret) return false;
  return signatureMatches(computeWebhookSignature(rawBody, secret), signatureHeader);
}
