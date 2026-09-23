/**
 * AES-GCM envelope encryption for sensitive offline fields.
 *
 * The key is generated per browser session and per user, and kept only in
 * `sessionStorage` under a user-scoped name. Consequences, stated plainly:
 * - Another user signing in on the same device, in the same or a new session,
 *   has no key for the previous user's records and cannot read them: records
 *   are listed per user, and opening the workspace purges any other user's
 *   key left in the tab (`purgeOtherSessionKeys`); sign-out discards the own key.
 * - Reloading the page or going offline keeps the key (sessionStorage survives
 *   both), so fieldwork survives connection loss within the same tab.
 * - Closing the tab or browser discards the key: encrypted drafts that were not
 *   synced become unreadable ("locked") and can only be discarded. Sync before
 *   closing the browser.
 * - sessionStorage is per tab; drafts captured in one tab are locked in another.
 * - This protects data at rest against a later user of the shared device. It
 *   does not protect against malware running while the session is open.
 */

const KEY_PREFIX = 'sxd-partner-offline-key:';
const ALGORITHM = 'AES-GCM';

export interface EncryptedEnvelope {
  v: 1;
  alg: 'AES-GCM';
  iv: string;
  data: string;
}

/** The subset of `Storage` the key handling needs (sessionStorage in the browser). */
export interface KeyStore {
  readonly length: number;
  key(index: number): string | null;
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  removeItem(name: string): void;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function fromBase64(value: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error('WebCrypto is not available in this browser');
  return c.subtle;
}

export function webCryptoSupported(): boolean {
  return (
    Boolean(globalThis.crypto?.subtle) && typeof globalThis.crypto.getRandomValues === 'function'
  );
}

function defaultKeyStore(): KeyStore | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    return sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Returns the session key for `userId`, creating one when absent. Returns null
 * when there is nowhere safe to keep it (no sessionStorage, e.g. blocked
 * storage), in which case callers must refuse to store sensitive fields.
 */
export async function getSessionKey(
  userId: string,
  store: KeyStore | null = defaultKeyStore(),
): Promise<CryptoKey | null> {
  if (!store || !webCryptoSupported()) return null;
  const name = `${KEY_PREFIX}${userId}`;
  let raw: Uint8Array;
  const existing = store.getItem(name);
  if (existing) {
    raw = fromBase64(existing);
  } else {
    raw = new Uint8Array(32);
    globalThis.crypto.getRandomValues(raw);
    store.setItem(name, toBase64(raw));
  }
  return subtle().importKey('raw', raw as BufferSource, { name: ALGORITHM }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export function hasSessionKey(userId: string, store: KeyStore | null = defaultKeyStore()): boolean {
  return Boolean(store?.getItem(`${KEY_PREFIX}${userId}`));
}

/** Forget the session key (sign-out); encrypted drafts become unreadable. */
export function discardSessionKey(
  userId: string,
  store: KeyStore | null = defaultKeyStore(),
): void {
  store?.removeItem(`${KEY_PREFIX}${userId}`);
}

/**
 * Removes every other user's key from this tab's session storage. Called when
 * a user opens the workspace, so a previous user who never signed out (session
 * expired, tab handed over) leaves no key behind that could open their
 * records. Their drafts become locked: only they, after syncing in their own
 * session, could have read them. Returns the number of keys removed.
 */
export function purgeOtherSessionKeys(
  userId: string,
  store: KeyStore | null = defaultKeyStore(),
): number {
  if (!store) return 0;
  const own = `${KEY_PREFIX}${userId}`;
  const stale: string[] = [];
  for (let i = 0; i < store.length; i += 1) {
    const name = store.key(i);
    if (name && name.startsWith(KEY_PREFIX) && name !== own) stale.push(name);
  }
  for (const name of stale) store.removeItem(name);
  return stale.length;
}

export async function encryptJson(key: CryptoKey, value: unknown): Promise<EncryptedEnvelope> {
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const cipher = await subtle().encrypt({ name: ALGORITHM, iv }, key, plain);
  return { v: 1, alg: 'AES-GCM', iv: toBase64(iv), data: toBase64(new Uint8Array(cipher)) };
}

export async function decryptJson<T>(key: CryptoKey, envelope: EncryptedEnvelope): Promise<T> {
  const plain = await subtle().decrypt(
    { name: ALGORITHM, iv: fromBase64(envelope.iv) as BufferSource },
    key,
    fromBase64(envelope.data) as BufferSource,
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

/** Binary envelope for photo bytes: stored as-is in IndexedDB (no base64 blow-up). */
export interface EncryptedBytes {
  v: 1;
  alg: 'AES-GCM';
  iv: Uint8Array;
  data: ArrayBuffer;
}

export async function encryptBytes(key: CryptoKey, bytes: ArrayBuffer): Promise<EncryptedBytes> {
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const data = await subtle().encrypt({ name: ALGORITHM, iv }, key, bytes);
  return { v: 1, alg: 'AES-GCM', iv, data };
}

export async function decryptBytes(key: CryptoKey, envelope: EncryptedBytes): Promise<ArrayBuffer> {
  return subtle().decrypt({ name: ALGORITHM, iv: envelope.iv as BufferSource }, key, envelope.data);
}

export function isEnvelope(value: unknown): value is EncryptedEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as EncryptedEnvelope).v === 1 &&
    (value as EncryptedEnvelope).alg === 'AES-GCM' &&
    typeof (value as EncryptedEnvelope).iv === 'string' &&
    typeof (value as EncryptedEnvelope).data === 'string'
  );
}
