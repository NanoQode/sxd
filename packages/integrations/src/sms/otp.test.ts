import { describe, expect, it } from 'vitest';
import {
  createOtpChallenge,
  decodeOtpHash,
  generateOtp,
  generateOtpSalt,
  hashOtp,
  verifyOtpAttempt,
} from './otp';

describe('otp helpers', () => {
  it('generates numeric codes of the requested length', () => {
    expect(generateOtp(6)).toMatch(/^\d{6}$/);
    expect(generateOtp(8)).toHaveLength(8);
    expect(() => generateOtp(3)).toThrow(/between/);
  });

  it('verifies the right code and rejects wrong, expired, exhausted and consumed challenges', () => {
    const now = new Date('2026-09-23T12:00:00Z');
    const challenge = createOtpChallenge({ now, ttlMinutes: 5, maxAttempts: 3 });
    expect(challenge.codeHash.startsWith('scrypt$')).toBe(true);
    expect(decodeOtpHash(challenge.codeHash)).not.toBeNull();
    expect(challenge.expiresAt.toISOString()).toBe('2026-09-23T12:05:00.000Z');

    const base = {
      storedHash: challenge.codeHash,
      attempts: 0,
      maxAttempts: challenge.maxAttempts,
      expiresAt: challenge.expiresAt,
      now,
    };
    const right = verifyOtpAttempt({ ...base, code: challenge.code });
    expect(right).toEqual({ ok: true, reason: 'verified', countAttempt: false });

    const wrongCode = `${(Number(challenge.code[0]) + 1) % 10}${challenge.code.slice(1)}`;
    expect(verifyOtpAttempt({ ...base, code: wrongCode })).toEqual({
      ok: false,
      reason: 'invalid_code',
      countAttempt: true,
    });
    expect(verifyOtpAttempt({ ...base, code: 'abc' }).reason).toBe('invalid_code');
    expect(
      verifyOtpAttempt({ ...base, code: challenge.code, now: new Date('2026-09-23T12:06:00Z') }),
    ).toEqual({ ok: false, reason: 'expired', countAttempt: false });
    expect(verifyOtpAttempt({ ...base, code: challenge.code, attempts: 3 })).toEqual({
      ok: false,
      reason: 'too_many_attempts',
      countAttempt: false,
    });
    expect(verifyOtpAttempt({ ...base, code: challenge.code, consumedAt: now }).reason).toBe(
      'consumed',
    );
    expect(verifyOtpAttempt({ ...base, storedHash: 'nonsense', code: challenge.code }).reason).toBe(
      'malformed_record',
    );
    // The verification result never echoes the code.
    expect(JSON.stringify(right)).not.toContain(challenge.code);
  });

  it('supports separate salt and hash storage', () => {
    const salt = generateOtpSalt();
    const hash = hashOtp('123456', salt);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      verifyOtpAttempt({
        storedHash: hash,
        salt,
        code: '123456',
        attempts: 0,
        maxAttempts: 5,
        expiresAt: new Date(Date.now() + 60_000),
      }).ok,
    ).toBe(true);
  });
});
