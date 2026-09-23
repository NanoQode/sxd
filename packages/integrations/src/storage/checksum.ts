import { createHash, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';

/**
 * Content checksums. The client-declared SHA-256 is user-provided evidence
 * metadata (like capture time and GPS); the server computes its own after
 * receipt and records both. A mismatch marks the upload as failed.
 */

export function sha256HexSync(buffer: Buffer | Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function sha256Hex(source: Buffer | Uint8Array | Readable): Promise<string> {
  if (!(source instanceof Readable)) return sha256HexSync(source);
  const hash = createHash('sha256');
  for await (const chunk of source) {
    hash.update(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Uint8Array));
  }
  return hash.digest('hex');
}

/** Accepts 64 hex characters (any case) or base64 of 32 bytes; returns lowercase hex. */
export function normalizeSha256(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/^sha256[:=-]/i, '');
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^[A-Za-z0-9+/]{43}=$/.test(trimmed) || /^[A-Za-z0-9_-]{43}$/.test(trimmed)) {
    const decoded = Buffer.from(trimmed, 'base64');
    if (decoded.length === 32) return decoded.toString('hex');
  }
  return null;
}

export type ChecksumVerification =
  | { ok: true; sha256: string }
  | { ok: false; reason: 'missing' | 'malformed' | 'mismatch'; sha256: string };

export function verifyDeclaredChecksum(
  declared: string | null | undefined,
  actualHex: string,
): ChecksumVerification {
  const actual = actualHex.toLowerCase();
  if (!declared) return { ok: false, reason: 'missing', sha256: actual };
  const normalized = normalizeSha256(declared);
  if (!normalized) return { ok: false, reason: 'malformed', sha256: actual };
  const a = Buffer.from(normalized, 'hex');
  const b = Buffer.from(actual, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b))
    return { ok: false, reason: 'mismatch', sha256: actual };
  return { ok: true, sha256: actual };
}
