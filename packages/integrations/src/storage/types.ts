import type { Readable } from 'node:stream';

/**
 * Object storage contract. Uploads land in the quarantine bucket, are
 * scanned, and only then are copied into the private bucket (originals) or
 * the derivatives bucket (compressed/redacted versions). A scanner `error`
 * verdict leaves the object in quarantine. Downloads are time-limited signed
 * URLs with explicit content-type and content-disposition overrides; markup
 * and scripts are never served inline.
 */

export type StorageProviderId = 's3' | 'local-dev';

/** Mirrors the `file_bucket` database enum. */
export type StorageBucket = 'private' | 'quarantine' | 'derivatives';

export interface ObjectLocation {
  bucket: StorageBucket;
  key: string;
}

export type ContentDisposition = 'attachment' | 'inline';

export interface UploadIntentInput {
  /** Defaults to `quarantine`; direct browser uploads may never target another bucket. */
  bucket?: StorageBucket;
  key: string;
  contentType: string;
  sizeBytes: number;
  multipart: boolean;
  /** Required when multipart (1–10000). */
  partCount?: number;
  expiresInSeconds?: number;
}

export interface SingleUploadIntent {
  kind: 'single';
  bucket: StorageBucket;
  key: string;
  method: 'PUT';
  url: string;
  /** Headers the client must send with the PUT. */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface MultipartUploadIntent {
  kind: 'multipart';
  bucket: StorageBucket;
  key: string;
  method: 'PUT';
  uploadId: string;
  partUrls: Array<{ partNumber: number; url: string }>;
  expiresAt: Date;
}

export type UploadIntent = SingleUploadIntent | MultipartUploadIntent;

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface CompleteMultipartInput {
  bucket?: StorageBucket;
  key: string;
  uploadId: string;
  parts: CompletedPart[];
}

export interface AbortMultipartInput {
  bucket?: StorageBucket;
  key: string;
  uploadId: string;
}

export interface ObjectHead {
  sizeBytes: number;
  contentType: string | null;
  etag: string | null;
  lastModified: Date | null;
}

export interface PutObjectOptions {
  /** Required for streams on S3 (single PUT needs a known length). */
  contentLength?: number;
}

export interface SignedDownloadInput extends ObjectLocation {
  expiresInSeconds?: number;
  fileName: string;
  contentType: string;
  /** Requested; the provider downgrades to `attachment` unless the type is inline-safe. */
  contentDisposition: ContentDisposition;
}

export interface SignedDownload {
  url: string;
  expiresAt: Date;
  /** Effective disposition after policy. */
  contentDisposition: ContentDisposition;
  /** Effective content type after policy (markup/scripts become application/octet-stream). */
  contentType: string;
  /** Full Content-Disposition header value the object will be served with. */
  headerValue: string;
}

export interface StorageProvider {
  readonly id: StorageProviderId;
  createUploadIntent(input: UploadIntentInput): Promise<UploadIntent>;
  completeMultipart(input: CompleteMultipartInput): Promise<{ etag: string | null }>;
  abortMultipart(input: AbortMultipartInput): Promise<void>;
  headObject(location: ObjectLocation): Promise<ObjectHead | null>;
  getObjectStream(location: ObjectLocation): Promise<Readable>;
  /** Server-side writes (derivatives, redacted copies). */
  putObject(
    location: ObjectLocation,
    body: Buffer | Uint8Array | Readable,
    contentType: string,
    options?: PutObjectOptions,
  ): Promise<{ etag: string | null }>;
  copyObject(from: ObjectLocation, to: ObjectLocation): Promise<void>;
  deleteObject(location: ObjectLocation): Promise<void>;
  /** Refused for the quarantine bucket: unscanned or failed-scan objects are never downloadable. */
  createSignedDownloadUrl(input: SignedDownloadInput): Promise<SignedDownload>;
  /** Every key in a bucket (operational tooling: storage reconciliation). */
  listKeys(bucket: StorageBucket): Promise<string[]>;
}

export type StorageErrorCode =
  'invalid_key' | 'invalid_request' | 'quarantined' | 'not_configured' | 'not_found' | 'provider';

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  constructor(message: string, code: StorageErrorCode = 'provider') {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

/** S3 limits (also enforced by MinIO). */
export const MULTIPART_MIN_PART_BYTES = 5 * 1024 * 1024;
export const MULTIPART_MAX_PARTS = 10_000;
export const SIGNED_URL_MAX_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_SIGNED_URL_SECONDS = 300;

/** Plans a resumable upload: part size and count for a declared size. */
export function planMultipartUpload(
  sizeBytes: number,
  partSizeBytes: number = 16 * 1024 * 1024,
): { partCount: number; partSizeBytes: number } {
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0)
    throw new StorageError('size must be positive', 'invalid_request');
  let partSize = Math.max(partSizeBytes, MULTIPART_MIN_PART_BYTES);
  let partCount = Math.ceil(sizeBytes / partSize);
  if (partCount > MULTIPART_MAX_PARTS) {
    partSize = Math.ceil(sizeBytes / MULTIPART_MAX_PARTS);
    partCount = Math.ceil(sizeBytes / partSize);
  }
  return { partCount, partSizeBytes: partSize };
}

export function clampExpiry(seconds: number | undefined, fallback: number): number {
  const value = seconds ?? fallback;
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), SIGNED_URL_MAX_SECONDS);
}
