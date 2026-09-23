import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Envelope encryption for stored provider secrets and OAuth tokens.
 *
 * Each secret gets its own random data-encryption key (DEK). The DEK encrypts
 * the plaintext with AES-256-GCM, and the DEK itself is wrapped with the
 * master key (also AES-256-GCM). Database backups therefore never contain
 * plaintext credentials; the master key lives in the environment or a KMS.
 * Rotation: a new master key is added as current and the previous key remains
 * readable until every record has been re-wrapped.
 */

export interface MasterKey {
  id: string;
  key: Buffer; // 32 bytes
}

export interface Keyring {
  current: MasterKey;
  previous?: MasterKey;
}

export interface EncryptedSecret {
  masterKeyId: string;
  wrappedDek: Buffer;
  dekIv: Buffer;
  dekTag: Buffer;
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  /** Stable, non-reversible identifier used to show "changed" without revealing the value. */
  fingerprint: string;
}

function decodeKey(value: string, label: string): Buffer {
  const trimmed = value.trim();
  let buf: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) buf = Buffer.from(trimmed, 'hex');
  else buf = Buffer.from(trimmed, 'base64');
  if (buf.length !== 32) {
    throw new Error(
      `${label} must decode to 32 bytes (got ${buf.length}); generate with: openssl rand -base64 32`,
    );
  }
  return buf;
}

export function keyringFromEnv(env: NodeJS.ProcessEnv = process.env): Keyring {
  const current = env.SECRETS_MASTER_KEY;
  if (!current) throw new Error('SECRETS_MASTER_KEY is not set');
  const keyring: Keyring = {
    current: {
      id: env.SECRETS_MASTER_KEY_ID ?? 'default',
      key: decodeKey(current, 'SECRETS_MASTER_KEY'),
    },
  };
  if (env.SECRETS_PREVIOUS_MASTER_KEY) {
    keyring.previous = {
      id: env.SECRETS_PREVIOUS_MASTER_KEY_ID ?? 'previous',
      key: decodeKey(env.SECRETS_PREVIOUS_MASTER_KEY, 'SECRETS_PREVIOUS_MASTER_KEY'),
    };
  }
  return keyring;
}

export function fingerprintSecret(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex').slice(0, 16);
}

export function encryptSecret(plaintext: string, keyring: Keyring): EncryptedSecret {
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const dekIv = randomBytes(12);
  const wrap = createCipheriv('aes-256-gcm', keyring.current.key, dekIv);
  wrap.setAAD(Buffer.from(keyring.current.id, 'utf8'));
  const wrappedDek = Buffer.concat([wrap.update(dek), wrap.final()]);
  const dekTag = wrap.getAuthTag();
  dek.fill(0);

  return {
    masterKeyId: keyring.current.id,
    wrappedDek,
    dekIv,
    dekTag,
    ciphertext,
    iv,
    tag,
    fingerprint: fingerprintSecret(plaintext),
  };
}

export function decryptSecret(record: EncryptedSecret, keyring: Keyring): string {
  const master =
    record.masterKeyId === keyring.current.id
      ? keyring.current
      : keyring.previous && record.masterKeyId === keyring.previous.id
        ? keyring.previous
        : null;
  if (!master) {
    throw new Error(
      `no master key available for key id ${record.masterKeyId}; rotation window expired`,
    );
  }
  const unwrap = createDecipheriv('aes-256-gcm', master.key, record.dekIv);
  unwrap.setAAD(Buffer.from(master.id, 'utf8'));
  unwrap.setAuthTag(record.dekTag);
  const dek = Buffer.concat([unwrap.update(record.wrappedDek), unwrap.final()]);
  const decipher = createDecipheriv('aes-256-gcm', dek, record.iv);
  decipher.setAuthTag(record.tag);
  const plaintext = Buffer.concat([decipher.update(record.ciphertext), decipher.final()]).toString(
    'utf8',
  );
  dek.fill(0);
  return plaintext;
}

/** Re-wraps a record under the current master key without exposing the plaintext to callers. */
export function rewrapSecret(record: EncryptedSecret, keyring: Keyring): EncryptedSecret {
  const plaintext = decryptSecret(record, keyring);
  return encryptSecret(plaintext, keyring);
}

/**
 * Masked presentation for admin screens: shows a recognisable prefix for
 * prefixed keys (sk_test_, pk_live_) and never the secret body.
 */
export function maskSecretPresence(
  plaintextOrPrefix: string | null,
  fingerprint: string | null,
): string {
  if (!fingerprint) return 'not set';
  const prefixMatch = plaintextOrPrefix ? /^(sk|pk)_(test|live)_/.exec(plaintextOrPrefix) : null;
  const prefix = prefixMatch ? prefixMatch[0] : '';
  return `${prefix}••••••••  (fingerprint ${fingerprint.slice(0, 8)})`;
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
