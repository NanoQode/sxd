/**
 * Stable JSON serialisation and a locally implemented FNV-1a hash for recommendation snapshots.
 *
 * No dependency and no I/O: the same value always serialises to the same string and hashes to the
 * same digest, whatever order its object keys were inserted in.
 */

/** JSON with object keys sorted recursively; `undefined` properties are omitted as JSON.stringify does. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalise(value)) ?? 'undefined';
}

function canonicalise(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item: unknown) => (item === undefined ? null : canonicalise(item)));
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const item = source[key];
    if (item !== undefined) out[key] = canonicalise(item);
  }
  return out;
}

/** FNV-1a, 32-bit, over UTF-16 code units, rendered as eight lowercase hex digits. */
export function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Stable digest of any JSON-like value, prefixed with the algorithm name. */
export function hashValue(value: unknown): string {
  return `fnv1a32:${fnv1a32(stableStringify(value))}`;
}
