import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Pure one-time-code helpers for `otp_challenges` (brief §13: OTPs expire,
 * are attempt-limited and are never logged).
 *
 * - The plaintext code exists only in the return value of `generateOtp` /
 *   `createOtpChallenge` so it can be rendered into the `otp` template once.
 *   Never put it in logs, job payloads that are logged, or error messages.
 * - Codes are stored as `scrypt$<salt>$<hash>` so that a database read alone
 *   does not yield usable codes (scrypt makes brute-forcing the 10^6 space
 *   slow; the attempt limit is the real defence).
 * - SMS OTP is not the only protection for privileged accounts: staff MFA
 *   prefers authenticator apps.
 */

export const OTP_DEFAULTS = {
  length: 6,
  ttlMinutes: 10,
  maxAttempts: 5,
} as const;

const OTP_MIN_LENGTH = 4;
const OTP_MAX_LENGTH = 10;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;

export function generateOtp(length: number = OTP_DEFAULTS.length): string {
  if (!Number.isInteger(length) || length < OTP_MIN_LENGTH || length > OTP_MAX_LENGTH) {
    throw new Error(`OTP length must be between ${OTP_MIN_LENGTH} and ${OTP_MAX_LENGTH}`);
  }
  let code = '';
  for (let i = 0; i < length; i += 1) code += String(randomInt(0, 10));
  return code;
}

export function generateOtpSalt(): string {
  return randomBytes(16).toString('hex');
}

export function hashOtp(code: string, salt: string): string {
  if (!salt) throw new Error('OTP salt is required');
  return scryptSync(code.normalize('NFKC'), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  }).toString('hex');
}

/** Single-column storage format for `otp_challenges.code_hash`. */
export function encodeOtpHash(salt: string, hash: string): string {
  return `scrypt$${salt}$${hash}`;
}

export function decodeOtpHash(stored: string): { salt: string; hash: string } | null {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt' || !parts[1] || !parts[2]) return null;
  return { salt: parts[1], hash: parts[2] };
}

export interface OtpChallengeOptions {
  length?: number;
  ttlMinutes?: number;
  maxAttempts?: number;
  now?: Date;
}

export interface OtpChallenge {
  /** Deliver once, then discard. Never log. */
  code: string;
  /** `scrypt$salt$hash` for `otp_challenges.code_hash`. */
  codeHash: string;
  expiresAt: Date;
  maxAttempts: number;
}

export function createOtpChallenge(options: OtpChallengeOptions = {}): OtpChallenge {
  const now = options.now ?? new Date();
  const ttl = options.ttlMinutes ?? OTP_DEFAULTS.ttlMinutes;
  const code = generateOtp(options.length ?? OTP_DEFAULTS.length);
  const salt = generateOtpSalt();
  return {
    code,
    codeHash: encodeOtpHash(salt, hashOtp(code, salt)),
    expiresAt: new Date(now.getTime() + ttl * 60_000),
    maxAttempts: options.maxAttempts ?? OTP_DEFAULTS.maxAttempts,
  };
}

export type OtpFailureReason =
  | 'consumed'
  | 'expired'
  | 'too_many_attempts'
  | 'invalid_code'
  | 'malformed_record';

export type OtpVerification =
  | { ok: true; reason: 'verified'; countAttempt: false }
  | { ok: false; reason: OtpFailureReason; countAttempt: boolean };

export interface OtpVerifyInput {
  /** Either the bare hash (with `salt` supplied) or the encoded `scrypt$salt$hash` string. */
  storedHash: string;
  salt?: string | null;
  code: string;
  attempts: number;
  maxAttempts: number;
  expiresAt: Date;
  now?: Date;
  consumedAt?: Date | null;
}

/**
 * Verifies one attempt. Never returns or echoes the code. `countAttempt`
 * tells the caller whether to increment `otp_challenges.attempts`.
 */
export function verifyOtpAttempt(input: OtpVerifyInput): OtpVerification {
  const now = input.now ?? new Date();
  if (input.consumedAt) return { ok: false, reason: 'consumed', countAttempt: false };
  if (input.attempts >= input.maxAttempts) {
    return { ok: false, reason: 'too_many_attempts', countAttempt: false };
  }
  if (now.getTime() >= input.expiresAt.getTime()) {
    return { ok: false, reason: 'expired', countAttempt: false };
  }

  let salt = input.salt ?? null;
  let hash = input.storedHash;
  if (!salt) {
    const decoded = decodeOtpHash(input.storedHash);
    if (!decoded) return { ok: false, reason: 'malformed_record', countAttempt: false };
    salt = decoded.salt;
    hash = decoded.hash;
  }

  const candidate = (input.code ?? '').trim();
  if (!/^\d{4,10}$/.test(candidate)) return { ok: false, reason: 'invalid_code', countAttempt: true };

  const expected = Buffer.from(hash, 'hex');
  const actual = Buffer.from(hashOtp(candidate, salt), 'hex');
  if (expected.length === 0 || expected.length !== actual.length) {
    return { ok: false, reason: 'invalid_code', countAttempt: true };
  }
  if (!timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'invalid_code', countAttempt: true };
  }
  return { ok: true, reason: 'verified', countAttempt: false };
}
