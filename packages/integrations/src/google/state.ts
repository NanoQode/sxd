import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * OAuth CSRF state and PKCE helpers. Pure node:crypto so they are testable
 * without googleapis. The application stores the unsigned state nonce and the
 * code verifier server-side (short-lived, bound to the admin session) and
 * sends the signed state to Google; on callback it verifies the signature and
 * age before exchanging the code.
 */

export const OAUTH_STATE_MAX_AGE_SECONDS = 600;

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

/** Random, URL-safe nonce (default 32 bytes). */
export function createOAuthState(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

function stateSignature(state: string, issuedAtSeconds: number, secret: string): string {
  return base64url(createHmac('sha256', secret).update(`${state}.${issuedAtSeconds}`).digest());
}

/** `${state}.${issuedAtSeconds}.${hmac}` — the value sent as the OAuth `state` parameter. */
export function signState(state: string, secret: string, issuedAt: Date = new Date()): string {
  if (!state || state.includes('.')) throw new Error('state must be a non-empty string without "."');
  if (!secret || secret.length < 16) throw new Error('state signing secret must be at least 16 characters');
  const issuedAtSeconds = Math.floor(issuedAt.getTime() / 1000);
  return `${state}.${issuedAtSeconds}.${stateSignature(state, issuedAtSeconds, secret)}`;
}

export type VerifyStateResult =
  | { ok: true; state: string; issuedAt: Date }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'not_yet_valid' };

export function verifyState(
  signed: string,
  secret: string,
  options: { now?: Date; maxAgeSeconds?: number } = {},
): VerifyStateResult {
  const parts = signed.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [state, issuedAtRaw, signature] = parts as [string, string, string];
  if (!state || !/^\d{1,12}$/.test(issuedAtRaw) || !signature)
    return { ok: false, reason: 'malformed' };
  const issuedAtSeconds = Number(issuedAtRaw);
  const expected = Buffer.from(stateSignature(state, issuedAtSeconds, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return { ok: false, reason: 'bad_signature' };
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const maxAge = options.maxAgeSeconds ?? OAUTH_STATE_MAX_AGE_SECONDS;
  if (issuedAtSeconds > nowSeconds + 60) return { ok: false, reason: 'not_yet_valid' };
  if (nowSeconds - issuedAtSeconds > maxAge) return { ok: false, reason: 'expired' };
  return { ok: true, state, issuedAt: new Date(issuedAtSeconds * 1000) };
}

/** RFC 7636 §4.1: 43–128 characters from the unreserved set. */
export function isValidCodeVerifier(verifier: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier);
}

/** 64 random bytes → 86 base64url characters (within the 43–128 limit). */
export function createCodeVerifier(): string {
  return base64url(randomBytes(64));
}

/** RFC 7636 §4.2: BASE64URL(SHA256(ASCII(code_verifier))) without padding. */
export function codeChallengeS256(verifier: string): string {
  if (!isValidCodeVerifier(verifier)) throw new Error('invalid PKCE code verifier');
  return base64url(createHash('sha256').update(verifier, 'ascii').digest());
}

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

export function createPkcePair(): PkcePair {
  const codeVerifier = createCodeVerifier();
  return { codeVerifier, codeChallenge: codeChallengeS256(codeVerifier), codeChallengeMethod: 'S256' };
}

/** Everything the app must remember (server-side, short-lived) between redirect and callback. */
export interface PendingAuthorization {
  state: string;
  signedState: string;
  codeVerifier: string;
  codeChallenge: string;
  issuedAt: Date;
}

export function beginAuthorization(secret: string, now: Date = new Date()): PendingAuthorization {
  const state = createOAuthState();
  const pkce = createPkcePair();
  return {
    state,
    signedState: signState(state, secret, now),
    codeVerifier: pkce.codeVerifier,
    codeChallenge: pkce.codeChallenge,
    issuedAt: now,
  };
}
