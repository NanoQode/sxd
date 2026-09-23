import { isValidStorageKey } from './keys';
import type { StorageBucket, StorageProvider } from './types';

/**
 * Read-only reconciliation of `file_objects` rows against the object store
 * (restore drills, docs/operations/backup-restore.md). It never writes to
 * either side; it reports what is missing from the bucket and what sits in
 * the bucket without a row.
 *
 * Expectations derived from a row:
 * - its original at `<bucket>/<storage_key>` while it is uploaded, scanning,
 *   clean, infected or scan_failed (`pending_upload` may legitimately have no
 *   object yet; `rejected`/`deleted` objects are removed and only reported as
 *   informational);
 * - every derivative key (web/thumb variants) in the derivatives bucket;
 *   `video: original` and `error: ...` entries are not keys.
 */

export type FileObjectStatus =
  | 'pending_upload'
  | 'uploaded'
  | 'scanning'
  | 'clean'
  | 'infected'
  | 'scan_failed'
  | 'rejected'
  | 'deleted';

export interface FileObjectLike {
  id: string;
  bucket: StorageBucket;
  storageKey: string;
  status: FileObjectStatus;
  derivatives?: Record<string, string> | null;
  deletedAt?: Date | string | null;
}

export interface ExpectedObject {
  bucket: StorageBucket;
  key: string;
  fileId: string;
  role: 'original' | 'derivative';
  status: FileObjectStatus;
  /** False for pending uploads and removed files: absence is not an error. */
  required: boolean;
}

export const REQUIRED_STATUSES: ReadonlySet<FileObjectStatus> = new Set([
  'uploaded',
  'scanning',
  'clean',
  'infected',
  'scan_failed',
]);

/** Keys the platform itself writes outside `file_objects` (health probes). */
export const DEFAULT_IGNORED_PREFIXES: readonly string[] = ['healthchecks/'];

export function expectedObjects(rows: readonly FileObjectLike[]): ExpectedObject[] {
  const out: ExpectedObject[] = [];
  for (const row of rows) {
    const removed = Boolean(row.deletedAt) || row.status === 'deleted';
    const status: FileObjectStatus = removed ? 'deleted' : row.status;
    out.push({
      bucket: row.bucket,
      key: row.storageKey,
      fileId: row.id,
      role: 'original',
      status,
      required: !removed && REQUIRED_STATUSES.has(row.status),
    });
    for (const [variant, value] of Object.entries(row.derivatives ?? {})) {
      if (variant === 'error' || value === 'original' || !isValidStorageKey(value)) continue;
      out.push({
        bucket: 'derivatives',
        key: value,
        fileId: row.id,
        role: 'derivative',
        status,
        required: !removed && row.status === 'clean',
      });
    }
  }
  return out;
}

export interface BucketListing {
  bucket: StorageBucket;
  keys: string[];
  /** Physical bucket name when two logical buckets share one store (S3 without a derivatives bucket). */
  physical?: string;
}

export interface ReconciliationReport {
  buckets: Array<{ bucket: StorageBucket; objects: number; expected: number }>;
  /** Rows whose object should exist but does not: restore the object or mark the row. */
  missing: ExpectedObject[];
  /** Objects with no row (or only a removed row): candidates for cleanup, never deleted here. */
  orphans: Array<{ bucket: StorageBucket; key: string }>;
  /** Objects that still exist for removed or rejected rows (retention clean-up not yet run). */
  lingering: ExpectedObject[];
  /** Pending uploads whose object has not arrived (normal within the upload window). */
  pending: number;
  ignoredPrefixes: string[];
  summary: { rows: number; expected: number; present: number; missing: number; orphans: number };
}

export function reconcileStorage(
  rows: readonly FileObjectLike[],
  listings: readonly BucketListing[],
  options: { ignoredPrefixes?: readonly string[] } = {},
): ReconciliationReport {
  const ignored = options.ignoredPrefixes ?? DEFAULT_IGNORED_PREFIXES;
  const expected = expectedObjects(rows);
  const byBucket = new Map<StorageBucket, Set<string>>();
  for (const listing of listings) {
    const set = byBucket.get(listing.bucket) ?? new Set<string>();
    for (const key of listing.keys) set.add(key);
    byBucket.set(listing.bucket, set);
  }
  const claimed = new Map<StorageBucket, Set<string>>();
  const missing: ExpectedObject[] = [];
  const lingering: ExpectedObject[] = [];
  let pending = 0;
  let present = 0;
  for (const item of expected) {
    const set = claimed.get(item.bucket) ?? new Set<string>();
    set.add(item.key);
    claimed.set(item.bucket, set);
    const exists = byBucket.get(item.bucket)?.has(item.key) ?? false;
    if (exists) {
      present += 1;
      if (item.status === 'deleted' || item.status === 'rejected') lingering.push(item);
    } else if (item.required) {
      missing.push(item);
    } else if (item.status === 'pending_upload') {
      pending += 1;
    }
  }
  // Keys claimed by any logical bucket that shares the same physical store count as known.
  const physicalOf = new Map<StorageBucket, string>();
  for (const listing of listings)
    physicalOf.set(listing.bucket, listing.physical ?? listing.bucket);
  const knownByPhysical = new Map<string, Set<string>>();
  for (const [bucket, keys] of claimed) {
    const physical = physicalOf.get(bucket) ?? bucket;
    const set = knownByPhysical.get(physical) ?? new Set<string>();
    for (const key of keys) set.add(key);
    knownByPhysical.set(physical, set);
  }
  const orphans: ReconciliationReport['orphans'] = [];
  const seenPhysical = new Set<string>();
  for (const [bucket, keys] of byBucket) {
    const physical = physicalOf.get(bucket) ?? bucket;
    if (seenPhysical.has(physical)) continue;
    seenPhysical.add(physical);
    const known = knownByPhysical.get(physical) ?? new Set<string>();
    for (const key of keys) {
      if (known.has(key)) continue;
      if (ignored.some((prefix) => key.startsWith(prefix))) continue;
      orphans.push({ bucket, key });
    }
  }
  orphans.sort((a, b) => a.bucket.localeCompare(b.bucket) || a.key.localeCompare(b.key));
  const buckets = (['private', 'quarantine', 'derivatives'] as const).map((bucket) => ({
    bucket,
    objects: byBucket.get(bucket)?.size ?? 0,
    expected: expected.filter((e) => e.bucket === bucket && e.required).length,
  }));
  return {
    buckets,
    missing,
    orphans,
    lingering,
    pending,
    ignoredPrefixes: [...ignored],
    summary: {
      rows: rows.length,
      expected: expected.filter((e) => e.required).length,
      present,
      missing: missing.length,
      orphans: orphans.length,
    },
  };
}

/**
 * Lists every bucket of a provider. When a provider maps two logical buckets
 * to one physical bucket (S3 without a derivatives bucket), the shared
 * listing is attributed to both so originals are never reported as orphans
 * of the derivatives bucket and vice versa.
 */
export async function listBuckets(
  provider: StorageProvider,
  physicalName?: (bucket: StorageBucket) => string,
): Promise<BucketListing[]> {
  const buckets: StorageBucket[] = ['private', 'quarantine', 'derivatives'];
  const cache = new Map<string, Promise<string[]>>();
  const listings: BucketListing[] = [];
  for (const bucket of buckets) {
    const physical = physicalName ? physicalName(bucket) : bucket;
    let keys = cache.get(physical);
    if (!keys) {
      keys = provider.listKeys(bucket);
      cache.set(physical, keys);
    }
    listings.push({ bucket, keys: await keys, physical });
  }
  return listings;
}
