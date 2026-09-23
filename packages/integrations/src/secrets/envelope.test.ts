import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  keyringFromEnv,
  maskSecretPresence,
  rewrapSecret,
  type Keyring,
} from './envelope';

const keyring: Keyring = { current: { id: 'k1', key: randomBytes(32) } };

describe('envelope encryption', () => {
  it('round-trips and never stores plaintext', () => {
    const rec = encryptSecret('sk_test_abc123', keyring);
    expect(rec.ciphertext.toString('utf8')).not.toContain('sk_test');
    expect(decryptSecret(rec, keyring)).toBe('sk_test_abc123');
    expect(rec.fingerprint).toHaveLength(16);
  });

  it('detects tampering', () => {
    const rec = encryptSecret('secret', keyring);
    const tampered = { ...rec, ciphertext: Buffer.from(rec.ciphertext) };
    tampered.ciphertext[0] = (tampered.ciphertext[0]! + 1) & 0xff;
    expect(() => decryptSecret(tampered, keyring)).toThrow();
    const wrongKeyId = { ...rec, masterKeyId: 'other' };
    expect(() => decryptSecret(wrongKeyId, keyring)).toThrow(/no master key/);
  });

  it('supports rotation with a previous key', () => {
    const rec = encryptSecret('value', keyring);
    const rotated: Keyring = {
      current: { id: 'k2', key: randomBytes(32) },
      previous: keyring.current,
    };
    expect(decryptSecret(rec, rotated)).toBe('value');
    const rewrapped = rewrapSecret(rec, rotated);
    expect(rewrapped.masterKeyId).toBe('k2');
    expect(decryptSecret(rewrapped, { current: rotated.current })).toBe('value');
    expect(rewrapped.fingerprint).toBe(rec.fingerprint);
  });

  it('loads keys from the environment and validates length', () => {
    const good = keyringFromEnv({
      SECRETS_MASTER_KEY: randomBytes(32).toString('base64'),
      SECRETS_MASTER_KEY_ID: 'env-1',
    });
    expect(good.current.id).toBe('env-1');
    expect(() => keyringFromEnv({ SECRETS_MASTER_KEY: 'short' })).toThrow(/32 bytes/);
    expect(() => keyringFromEnv({})).toThrow(/not set/);
  });

  it('masks presence without revealing the body', () => {
    expect(maskSecretPresence('sk_live_verysecret', 'abcdef1234567890')).toBe(
      'sk_live_••••••••  (fingerprint abcdef12)',
    );
    expect(maskSecretPresence(null, null)).toBe('not set');
  });
});
