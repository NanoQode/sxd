import { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { contentDispositionHeader, resolveContentDisposition } from './disposition';
import { assertValidStorageKey } from './keys';
import {
  DEFAULT_SIGNED_URL_SECONDS,
  MULTIPART_MAX_PARTS,
  StorageError,
  clampExpiry,
  type AbortMultipartInput,
  type CompleteMultipartInput,
  type ObjectHead,
  type ObjectLocation,
  type PutObjectOptions,
  type SignedDownload,
  type SignedDownloadInput,
  type StorageBucket,
  type StorageProvider,
  type UploadIntent,
  type UploadIntentInput,
} from './types';

/**
 * S3-compatible storage (AWS S3, MinIO, Cloudflare R2, …). Buckets are
 * private; browsers upload with presigned PUT/part URLs and download with
 * presigned GET URLs carrying response-content-disposition and
 * response-content-type overrides. Presigned PUT URLs sign the declared
 * content-length, so a URL issued for N bytes cannot upload a different size.
 * Content-Type is not part of the signature (browser charset quirks), which is
 * why the server re-detects the type after receipt (see mime.ts).
 */

export interface S3BucketNames {
  private: string;
  quarantine: string;
  /** Defaults to the private bucket (keys already separate originals from variants). */
  derivatives?: string | null;
}

export interface S3StorageOptions {
  region: string;
  /** Custom endpoint for MinIO/R2; omit for AWS. */
  endpoint?: string | null;
  /** Required for MinIO and most self-hosted stores. */
  forcePathStyle?: boolean;
  /** Static credentials; omit to use the SDK's default chain (IAM role). */
  credentials?: { accessKeyId: string; secretAccessKey: string } | null;
  buckets: S3BucketNames;
  signedUrlTtlSeconds?: number;
  /** Test seam: inject a configured client (presigning needs a real S3Client). */
  client?: S3Client;
  /** Test seam: intercept `send` for head/put/copy/delete/multipart calls. */
  transport?: Pick<S3Client, 'send'>;
  /** Test seam: replace the presigner. */
  presign?: typeof getSignedUrl;
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

function encodeCopySource(bucket: string, key: string): string {
  return `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

export function createS3Client(options: S3StorageOptions): S3Client {
  return new S3Client({
    region: options.region,
    endpoint: options.endpoint ?? undefined,
    forcePathStyle: options.forcePathStyle ?? false,
    credentials: options.credentials ?? undefined,
    // Newer SDKs add CRC checksums to every PUT; browsers uploading through
    // presigned URLs cannot supply them, and MinIO rejects the trailer form.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

export class S3StorageProvider implements StorageProvider {
  readonly id = 's3' as const;
  private readonly client: S3Client;
  private readonly transport: Pick<S3Client, 'send'>;
  private readonly presign: typeof getSignedUrl;
  private readonly buckets: S3BucketNames;
  private readonly ttl: number;

  constructor(options: S3StorageOptions) {
    if (!options.buckets.private || !options.buckets.quarantine) {
      throw new StorageError(
        'S3 private and quarantine bucket names are required',
        'not_configured',
      );
    }
    if (options.buckets.private === options.buckets.quarantine) {
      throw new StorageError('quarantine and private buckets must be different', 'not_configured');
    }
    if (options.endpoint && !/^https?:\/\//.test(options.endpoint)) {
      throw new StorageError('S3 endpoint must be an absolute http(s) URL', 'not_configured');
    }
    this.client = options.client ?? createS3Client(options);
    this.transport = options.transport ?? this.client;
    this.presign = options.presign ?? getSignedUrl;
    this.buckets = options.buckets;
    this.ttl = clampExpiry(options.signedUrlTtlSeconds, DEFAULT_SIGNED_URL_SECONDS);
  }

  bucketName(bucket: StorageBucket): string {
    switch (bucket) {
      case 'private':
        return this.buckets.private;
      case 'quarantine':
        return this.buckets.quarantine;
      case 'derivatives':
        return this.buckets.derivatives || this.buckets.private;
      default:
        throw new StorageError(`unknown bucket ${String(bucket)}`, 'invalid_request');
    }
  }

  private expiresAt(seconds: number): Date {
    return new Date(Date.now() + seconds * 1000);
  }

  async createUploadIntent(input: UploadIntentInput): Promise<UploadIntent> {
    assertValidStorageKey(input.key);
    const bucket = input.bucket ?? 'quarantine';
    if (bucket !== 'quarantine') {
      throw new StorageError('direct uploads must target the quarantine bucket', 'invalid_request');
    }
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0)
      throw new StorageError('sizeBytes must be a positive integer', 'invalid_request');
    const Bucket = this.bucketName(bucket);
    const expiresIn = clampExpiry(input.expiresInSeconds, this.ttl);
    if (!input.multipart) {
      const url = await this.presign(
        this.client,
        new PutObjectCommand({
          Bucket,
          Key: input.key,
          ContentType: input.contentType,
          ContentLength: input.sizeBytes,
        }),
        { expiresIn },
      );
      return {
        kind: 'single',
        bucket,
        key: input.key,
        method: 'PUT',
        url,
        headers: { 'Content-Type': input.contentType },
        expiresAt: this.expiresAt(expiresIn),
      };
    }
    const partCount = input.partCount ?? 0;
    if (!Number.isInteger(partCount) || partCount < 1 || partCount > MULTIPART_MAX_PARTS)
      throw new StorageError(
        `partCount must be between 1 and ${MULTIPART_MAX_PARTS}`,
        'invalid_request',
      );
    const created = await this.transport.send(
      new CreateMultipartUploadCommand({ Bucket, Key: input.key, ContentType: input.contentType }),
    );
    if (!created.UploadId) throw new StorageError('storage did not return an upload id');
    const partUrls: Array<{ partNumber: number; url: string }> = [];
    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      const url = await this.presign(
        this.client,
        new UploadPartCommand({
          Bucket,
          Key: input.key,
          UploadId: created.UploadId,
          PartNumber: partNumber,
        }),
        { expiresIn },
      );
      partUrls.push({ partNumber, url });
    }
    return {
      kind: 'multipart',
      bucket,
      key: input.key,
      method: 'PUT',
      uploadId: created.UploadId,
      partUrls,
      expiresAt: this.expiresAt(expiresIn),
    };
  }

  async completeMultipart(input: CompleteMultipartInput): Promise<{ etag: string | null }> {
    assertValidStorageKey(input.key);
    if (input.parts.length === 0)
      throw new StorageError('at least one part is required', 'invalid_request');
    const parts = [...input.parts].sort((a, b) => a.partNumber - b.partNumber);
    const result = await this.transport.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucketName(input.bucket ?? 'quarantine'),
        Key: input.key,
        UploadId: input.uploadId,
        MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      }),
    );
    return { etag: result.ETag ?? null };
  }

  async abortMultipart(input: AbortMultipartInput): Promise<void> {
    assertValidStorageKey(input.key);
    await this.transport.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucketName(input.bucket ?? 'quarantine'),
        Key: input.key,
        UploadId: input.uploadId,
      }),
    );
  }

  async headObject(location: ObjectLocation): Promise<ObjectHead | null> {
    assertValidStorageKey(location.key);
    try {
      const head = await this.transport.send(
        new HeadObjectCommand({ Bucket: this.bucketName(location.bucket), Key: location.key }),
      );
      return {
        sizeBytes: head.ContentLength ?? 0,
        contentType: head.ContentType ?? null,
        etag: head.ETag ?? null,
        lastModified: head.LastModified ?? null,
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async getObjectStream(location: ObjectLocation): Promise<Readable> {
    assertValidStorageKey(location.key);
    let body: unknown;
    try {
      ({ Body: body } = await this.transport.send(
        new GetObjectCommand({ Bucket: this.bucketName(location.bucket), Key: location.key }),
      ));
    } catch (err) {
      if (isNotFound(err)) throw new StorageError(`object not found: ${location.key}`, 'not_found');
      throw err;
    }
    if (body instanceof Readable) return body;
    if (
      body &&
      typeof (body as { transformToByteArray?: unknown }).transformToByteArray === 'function'
    ) {
      const bytes = await (
        body as { transformToByteArray(): Promise<Uint8Array> }
      ).transformToByteArray();
      return Readable.from(Buffer.from(bytes));
    }
    throw new StorageError('storage returned an unreadable body');
  }

  async putObject(
    location: ObjectLocation,
    body: Buffer | Uint8Array | Readable,
    contentType: string,
    options: PutObjectOptions = {},
  ): Promise<{ etag: string | null }> {
    assertValidStorageKey(location.key);
    const isStream = body instanceof Readable;
    if (isStream && options.contentLength === undefined)
      throw new StorageError(
        'contentLength is required when uploading a stream',
        'invalid_request',
      );
    const result = await this.transport.send(
      new PutObjectCommand({
        Bucket: this.bucketName(location.bucket),
        Key: location.key,
        Body: body,
        ContentType: contentType,
        ContentLength: isStream ? options.contentLength : body.byteLength,
      }),
    );
    return { etag: result.ETag ?? null };
  }

  async copyObject(from: ObjectLocation, to: ObjectLocation): Promise<void> {
    assertValidStorageKey(from.key);
    assertValidStorageKey(to.key);
    await this.transport.send(
      new CopyObjectCommand({
        Bucket: this.bucketName(to.bucket),
        Key: to.key,
        CopySource: encodeCopySource(this.bucketName(from.bucket), from.key),
        MetadataDirective: 'COPY',
      }),
    );
  }

  async deleteObject(location: ObjectLocation): Promise<void> {
    assertValidStorageKey(location.key);
    await this.transport.send(
      new DeleteObjectCommand({ Bucket: this.bucketName(location.bucket), Key: location.key }),
    );
  }

  /** Lists every key in a bucket, following continuation tokens (reconciliation tooling). */
  async listKeys(bucket: StorageBucket): Promise<string[]> {
    const Bucket = this.bucketName(bucket);
    const keys: string[] = [];
    let ContinuationToken: string | undefined;
    do {
      const page = await this.transport.send(
        new ListObjectsV2Command({ Bucket, ContinuationToken, MaxKeys: 1000 }),
      );
      for (const object of page.Contents ?? []) if (object.Key) keys.push(object.Key);
      ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (ContinuationToken);
    return keys.sort();
  }

  async createSignedDownloadUrl(input: SignedDownloadInput): Promise<SignedDownload> {
    assertValidStorageKey(input.key);
    if (input.bucket === 'quarantine') {
      throw new StorageError('objects in quarantine cannot be downloaded', 'quarantined');
    }
    const resolved = resolveContentDisposition(input.contentType, input.contentDisposition);
    const headerValue = contentDispositionHeader(resolved.disposition, input.fileName);
    const expiresIn = clampExpiry(input.expiresInSeconds, this.ttl);
    const url = await this.presign(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucketName(input.bucket),
        Key: input.key,
        ResponseContentDisposition: headerValue,
        ResponseContentType: resolved.contentType,
        ResponseCacheControl: 'private, no-store',
      }),
      { expiresIn },
    );
    return {
      url,
      expiresAt: this.expiresAt(expiresIn),
      contentDisposition: resolved.disposition,
      contentType: resolved.contentType,
      headerValue,
    };
  }
}
