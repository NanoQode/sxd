import { describe, expect, it } from 'vitest';
import {
  beginAuthorization,
  codeChallengeS256,
  createCodeVerifier,
  createOAuthState,
  createPkcePair,
  isValidCodeVerifier,
  signState,
  verifyState,
} from './state';

const secret = 'state-signing-secret-for-tests-0123456789';

describe('OAuth state', () => {
  it('signs and verifies a state nonce', () => {
    const state = createOAuthState();
    expect(state).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const issuedAt = new Date('2026-09-23T10:00:00Z');
    const signed = signState(state, secret, issuedAt);
    const result = verifyState(signed, secret, { now: new Date('2026-09-23T10:05:00Z') });
    expect(result).toEqual({ ok: true, state, issuedAt });
  });

  it('rejects tampering, wrong secrets and malformed values', () => {
    const signed = signState('nonce123', secret);
    const [state, ts, sig] = signed.split('.') as [string, string, string];
    expect(verifyState(`${state}x.${ts}.${sig}`, secret)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyState(signed, 'another-secret-that-is-long-enough')).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(verifyState('nonce123', secret)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyState(`${state}.abc.${sig}`, secret)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('expires after the maximum age and rejects future timestamps', () => {
    const issuedAt = new Date('2026-09-23T10:00:00Z');
    const signed = signState('nonce', secret, issuedAt);
    expect(verifyState(signed, secret, { now: new Date('2026-09-23T10:11:00Z') })).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(verifyState(signed, secret, { now: new Date('2026-09-23T09:00:00Z') })).toEqual({
      ok: false,
      reason: 'not_yet_valid',
    });
  });

  it('refuses weak secrets and states containing separators', () => {
    expect(() => signState('a.b', secret)).toThrow(/without "\."/);
    expect(() => signState('abc', 'short')).toThrow(/16 characters/);
  });
});

describe('PKCE', () => {
  it('matches the RFC 7636 appendix B vector', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(codeChallengeS256(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('generates valid verifiers and pairs', () => {
    const verifier = createCodeVerifier();
    expect(isValidCodeVerifier(verifier)).toBe(true);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    const pair = createPkcePair();
    expect(pair.codeChallengeMethod).toBe('S256');
    expect(pair.codeChallenge).toBe(codeChallengeS256(pair.codeVerifier));
    expect(() => codeChallengeS256('too-short')).toThrow(/invalid PKCE/);
  });

  it('bundles state and PKCE for a pending authorisation', () => {
    const pending = beginAuthorization(secret, new Date('2026-09-23T10:00:00Z'));
    expect(verifyState(pending.signedState, secret, { now: new Date('2026-09-23T10:01:00Z') })).toMatchObject({
      ok: true,
      state: pending.state,
    });
    expect(pending.codeChallenge).toBe(codeChallengeS256(pending.codeVerifier));
  });
});
