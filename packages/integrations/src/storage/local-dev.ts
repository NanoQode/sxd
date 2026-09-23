import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { contentDispositionHeader, resolveContentDisposition } from './disposition';
import { assertValidStorageKey } from './keys';
import {
  DEFAULT_SIGNED_URL_SECONDS,
  MULTIPART_MAX_PARTS,
  StorageError,
  clampExpiry,
  type AbortMultipartInput,
  type CompleteMultipartInput,
  type ContentDisposition,
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
 * DEVELOPMENT ADAPTER — filesystem-backed, labelled, refused outside
 * APP_ENV=development|test. Objects live under `<root>/<bucket>/<key>` with a
 * content-type sidecar under `<root>/.meta/`. "Signed" URLs point at
 * `${appUrl}/api/v1/dev/storage/<op>` with an HMAC token and expiry; the app
 * serves that route in development only and calls `verifySignedRequest`
 * before touching the filesystem.
 */

export type DevStorageOp = 'upload' | 'part' | 'download';

export interface DevSignedParams {
  op: DevStorageOp;
  bucket: StorageBucket;
  key: string;
  expiresAt: Date;
  contentType: string | null;
  sizeBytes: number | null;
  fileName: string | null;
  disposition: ContentDisposition | null;
  uploadId: string | null;
  partNumber: number | null;
}

export interface LocalDevStorageOptions {
  appEnv: string;
  /** Default ./uploads-dev (git-ignored). */
  root?: string;
  appUrl: string;
  /** HMAC key for signed dev URLs (any long random string; AUTH_SECRET is fine in development). */
  signingSecret: string;
  signedUrlTtlSeconds?: number;
  now?: () => Date;
}

export const DEV_STORAGE_ROUTE_PREFIX = '/api/v1/dev/storage';
const BUCKETS: readonly StorageBucket[] = ['private', 'quarantine', 'derivatives'];
const SIGNED_FIELDS = [
  'op',
  'bucket',
  'key',
  'exp',
  'type',
  'size',
  'name',
  'disposition',
  'uploadId',
  'partNumber',
] as const;

function canonical(params: URLSearchParams): string {
  return SIGNED_FIELDS.map((field) => `${field}=${params.get(field) ?? ''}`).join('&');
}

export function signDevStorageParams(params: URLSearchParams, secret: string): string {
  return createHmac('sha256', secret).update(canonical(params)).digest('base64url');
}

export interface DevSignInput {
  op: DevStorageOp;
  bucket: StorageBucket;
  key: string;
  expiresAt: Date;
  contentType?: string | null;
  sizeBytes?: number | null;
  fileName?: string | null;
  disposition?: ContentDisposition | null;
  uploadId?: string | null;
  partNumber?: number | null;
}

export function signDevStorageUrl(appUrl: string, secret: string, input: DevSignInput): string {
  const url = new URL(`${DEV_STORAGE_ROUTE_PREFIX}/${input.op}`, appUrl);
  const params = url.searchParams;
  params.set('op', input.op);
  params.set('bucket', input.bucket);
  params.set('key', input.key);
  params.set('exp', String(Math.floor(input.expiresAt.getTime() / 1000)));
  if (input.contentType) params.set('type', input.contentType);
  if (input.sizeBytes !== undefined && input.sizeBytes !== null)
    params.set('size', String(input.sizeBytes));
  if (input.fileName) params.set('name', input.fileName);
  if (input.disposition) params.set('disposition', input.disposition);
  if (input.uploadId) params.set('uploadId', input.uploadId);
  if (input.partNumber !== undefined && input.partNumber !== null)
    params.set('partNumber', String(input.partNumber));
  params.set('sig', signDevStorageParams(params, secret));
  return url.toString();
}

export type DevVerifyResult = { ok: true; params: DevSignedParams } | { ok: false; reason: string };

export function verifyDevStorageUrl(
  url: URL | string,
  secret: string,
  now: Date = new Date(),
): DevVerifyResult {
  const parsed = typeof url === 'string' ? new URL(url, 'http://localhost') : url;
  const params = parsed.searchParams;
  const sig = params.get('sig');
  if (!sig) return { ok: false, reason: 'missing signature' };
  const expected = Buffer.from(signDevStorageParams(params, secret));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return { ok: false, reason: 'bad signature' };
  const op = params.get('op');
  const bucket = params.get('bucket');
  const key = params.get('key') ?? '';
  const exp = Number(params.get('exp'));
  if (op !== 'upload' && op !== 'part' && op !== 'download')
    return { ok: false, reason: 'unknown op' };
  if (!bucket || !BUCKETS.includes(bucket as StorageBucket))
    return { ok: false, reason: 'unknown bucket' };
  if (!Number.isFinite(exp)) return { ok: false, reason: 'malformed expiry' };
  if (exp * 1000 < now.getTime()) return { ok: false, reason: 'expired' };
  const pathOp = parsed.pathname.split('/').pop();
  if (pathOp !== op) return { ok: false, reason: 'path/op mismatch' };
  try {
    assertValidStorageKey(key);
  } catch {
    return { ok: false, reason: 'invalid key' };
  }
  const disposition = params.get('disposition');
  const size = params.get('size');
  const partNumber = params.get('partNumber');
  return {
    ok: true,
    params: {
      op,
      bucket: bucket as StorageBucket,
      key,
      expiresAt: new Date(exp * 1000),
      contentType: params.get('type'),
      sizeBytes: size ? Number(size) : null,
      fileName: params.get('name'),
      disposition: disposition === 'inline' || disposition === 'attachment' ? disposition : null,
      uploadId: params.get('uploadId'),
      partNumber: partNumber ? Number(partNumber) : null,
    },
  };
}

interface Meta {
  contentType: string;
}

export class LocalDevStorageProvider implements StorageProvider {
  readonly id = 'local-dev' as const;
  readonly root: string;
  private readonly options: LocalDevStorageOptions;
  private readonly ttl: number;

  constructor(options: LocalDevStorageOptions) {
    if (options.appEnv !== 'development' && options.appEnv !== 'test') {
      throw new StorageError(
        `LocalDevStorageProvider is a development adapter and cannot be used when APP_ENV=${options.appEnv}; configure STORAGE_PROVIDER=s3`,
        'not_configured',
      );
    }
    if (!options.signingSecret || options.signingSecret.length < 16)
      throw new StorageError(
        'local-dev storage needs a signing secret of at least 16 characters',
        'not_configured',
      );
    this.options = options;
    this.root = path.resolve(options.root ?? './uploads-dev');
    this.ttl = clampExpiry(options.signedUrlTtlSeconds, DEFAULT_SIGNED_URL_SECONDS);
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private objectPath(location: ObjectLocation): string {
    assertValidStorageKey(location.key);
    if (!BUCKETS.includes(location.bucket))
      throw new StorageError('unknown bucket', 'invalid_request');
    const full = path.resolve(this.root, location.bucket, location.key);
    if (!full.startsWith(`${this.root}${path.sep}`))
      throw new StorageError('key escapes the storage root', 'invalid_key');
    return full;
  }

  private metaPath(location: ObjectLocation): string {
    return path.resolve(this.root, '.meta', location.bucket, `${location.key}.json`);
  }

  private partDir(uploadId: string): string {
    if (!/^[a-f0-9-]{36}$/.test(uploadId))
      throw new StorageError('invalid upload id', 'invalid_request');
    return path.resolve(this.root, '.multipart', uploadId);
  }

  private async writeMeta(location: ObjectLocation, meta: Meta): Promise<void> {
    const file = this.metaPath(location);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(meta));
  }

  private async readMeta(location: ObjectLocation): Promise<Meta | null> {
    try {
      return JSON.parse(await readFile(this.metaPath(location), 'utf8')) as Meta;
    } catch {
      return null;
    }
  }

  verifySignedRequest(url: URL | string): DevVerifyResult {
    return verifyDevStorageUrl(url, this.options.signingSecret, this.now());
  }

  async createUploadIntent(input: UploadIntentInput): Promise<UploadIntent> {
    assertValidStorageKey(input.key);
    const bucket = input.bucket ?? 'quarantine';
    if (bucket !== 'quarantine')
      throw new StorageError('direct uploads must target the quarantine bucket', 'invalid_request');
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0)
      throw new StorageError('sizeBytes must be a positive integer', 'invalid_request');
    const expiresIn = clampExpiry(input.expiresInSeconds, this.ttl);
    const expiresAt = new Date(this.now().getTime() + expiresIn * 1000);
    const base = { bucket, key: input.key, expiresAt, contentType: input.contentType };
    if (!input.multipart) {
      return {
        kind: 'single',
        bucket,
        key: input.key,
        method: 'PUT',
        url: signDevStorageUrl(this.options.appUrl, this.options.signingSecret, {
          ...base,
          op: 'upload',
          sizeBytes: input.sizeBytes,
        }),
        headers: { 'Content-Type': input.contentType },
        expiresAt,
      };
    }
    const partCount = input.partCount ?? 0;
    if (!Number.isInteger(partCount) || partCount < 1 || partCount > MULTIPART_MAX_PARTS)
      throw new StorageError(
        `partCount must be between 1 and ${MULTIPART_MAX_PARTS}`,
        'invalid_request',
      );
    const uploadId = randomUUID();
    await mkdir(this.partDir(uploadId), { recursive: true });
    await writeFile(
      path.join(this.partDir(uploadId), 'meta.json'),
      JSON.stringify({ bucket, key: input.key, contentType: input.contentType }),
    );
    const partUrls = [];
    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      partUrls.push({
        partNumber,
        url: signDevStorageUrl(this.options.appUrl, this.options.signingSecret, {
          ...base,
          op: 'part',
          uploadId,
          partNumber,
        }),
      });
    }
    return {
      kind: 'multipart',
      bucket,
      key: input.key,
      method: 'PUT',
      uploadId,
      partUrls,
      expiresAt,
    };
  }

  /** Dev route handler for `upload`: streams the body to disk, enforcing the signed size. */
  async writeUploadedObject(
    params: DevSignedParams,
    body: Readable | Buffer | Uint8Array,
  ): Promise<{ sizeBytes: number; etag: string }> {
    if (params.op !== 'upload')
      throw new StorageError('signed URL is not an upload URL', 'invalid_request');
    const target = this.objectPath({ bucket: params.bucket, key: params.key });
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.uploading-${randomUUID()}`;
    const hash = createHash('sha256');
    let size = 0;
    const source = body instanceof Readable ? body : Readable.from(Buffer.from(body));
    const counted = new Readable({
      read() {},
    });
    const pump = (async () => {
      for await (const chunk of source) {
        const buf =
          typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
        size += buf.length;
        hash.update(buf);
        counted.push(buf);
      }
      counted.push(null);
    })();
    await Promise.all([pipeline(counted, createWriteStream(tmp)), pump]);
    if (params.sizeBytes !== null && size !== params.sizeBytes) {
      await rm(tmp, { force: true });
      throw new StorageError(
        `upload size ${size} does not match the signed size ${params.sizeBytes}`,
        'invalid_request',
      );
    }
    await rename(tmp, target);
    await this.writeMeta(
      { bucket: params.bucket, key: params.key },
      { contentType: params.contentType ?? 'application/octet-stream' },
    );
    return { sizeBytes: size, etag: `"${hash.digest('hex')}"` };
  }

  /** Dev route handler for `part`: stores one multipart part and returns its ETag. */
  async writeUploadedPart(
    params: DevSignedParams,
    body: Readable | Buffer | Uint8Array,
  ): Promise<{ etag: string }> {
    if (params.op !== 'part' || !params.uploadId || !params.partNumber)
      throw new StorageError('signed URL is not a part URL', 'invalid_request');
    const dir = this.partDir(params.uploadId);
    await stat(dir).catch(() => {
      throw new StorageError('unknown or aborted multipart upload', 'not_found');
    });
    const data = body instanceof Readable ? Buffer.concat(await collect(body)) : Buffer.from(body);
    const etag = `"${createHash('sha256').update(data).digest('hex')}"`;
    await writeFile(path.join(dir, `${params.partNumber}.part`), data);
    await writeFile(path.join(dir, `${params.partNumber}.etag`), etag);
    return { etag };
  }

  async completeMultipart(input: CompleteMultipartInput): Promise<{ etag: string | null }> {
    assertValidStorageKey(input.key);
    const dir = this.partDir(input.uploadId);
    const meta = JSON.parse(
      await readFile(path.join(dir, 'meta.json'), 'utf8').catch(() => {
        throw new StorageError('unknown or aborted multipart upload', 'not_found');
      }),
    ) as { bucket: StorageBucket; key: string; contentType: string };
    if (meta.key !== input.key)
      throw new StorageError('upload id does not belong to this key', 'invalid_request');
    const parts = [...input.parts].sort((a, b) => a.partNumber - b.partNumber);
    const location = { bucket: input.bucket ?? meta.bucket, key: input.key };
    const target = this.objectPath(location);
    await mkdir(path.dirname(target), { recursive: true });
    const hash = createHash('sha256');
    const out = createWriteStream(target);
    const failed = new Promise<never>((_resolve, reject) => out.once('error', reject));
    try {
      for (const part of parts) {
        const stored = await readFile(path.join(dir, `${part.partNumber}.etag`), 'utf8').catch(
          () => null,
        );
        if (stored === null)
          throw new StorageError(`part ${part.partNumber} was not uploaded`, 'invalid_request');
        if (stored !== part.etag)
          throw new StorageError(`part ${part.partNumber} etag mismatch`, 'invalid_request');
        const data = await readFile(path.join(dir, `${part.partNumber}.part`));
        hash.update(data);
        if (!out.write(data))
          await Promise.race([
            new Promise<void>((resolve) => out.once('drain', () => resolve())),
            failed,
          ]);
      }
      await Promise.race([new Promise<void>((resolve) => out.end(() => resolve())), failed]);
    } catch (err) {
      out.destroy();
      await rm(target, { force: true });
      throw err;
    }
    await this.writeMeta(location, { contentType: meta.contentType });
    await rm(dir, { recursive: true, force: true });
    return { etag: `"${hash.digest('hex')}-${parts.length}"` };
  }

  async abortMultipart(input: AbortMultipartInput): Promise<void> {
    await rm(this.partDir(input.uploadId), { recursive: true, force: true });
  }

  async headObject(location: ObjectLocation): Promise<ObjectHead | null> {
    const file = this.objectPath(location);
    try {
      const info = await stat(file);
      const meta = await this.readMeta(location);
      const etag = `"${createHash('sha256')
        .update(await readFile(file))
        .digest('hex')}"`;
      return {
        sizeBytes: info.size,
        contentType: meta?.contentType ?? null,
        etag,
        lastModified: info.mtime,
      };
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return null;
      throw err;
    }
  }

  async getObjectStream(location: ObjectLocation): Promise<Readable> {
    const file = this.objectPath(location);
    await stat(file).catch(() => {
      throw new StorageError(`object not found: ${location.key}`, 'not_found');
    });
    return createReadStream(file);
  }

  async putObject(
    location: ObjectLocation,
    body: Buffer | Uint8Array | Readable,
    contentType: string,
    _options: PutObjectOptions = {},
  ): Promise<{ etag: string | null }> {
    const file = this.objectPath(location);
    await mkdir(path.dirname(file), { recursive: true });
    const data = body instanceof Readable ? Buffer.concat(await collect(body)) : Buffer.from(body);
    await writeFile(file, data);
    await this.writeMeta(location, { contentType });
    return { etag: `"${createHash('sha256').update(data).digest('hex')}"` };
  }

  async copyObject(from: ObjectLocation, to: ObjectLocation): Promise<void> {
    const source = this.objectPath(from);
    const target = this.objectPath(to);
    await stat(source).catch(() => {
      throw new StorageError(`object not found: ${from.key}`, 'not_found');
    });
    await mkdir(path.dirname(target), { recursive: true });
    await pipeline(createReadStream(source), createWriteStream(target));
    const meta = await this.readMeta(from);
    await this.writeMeta(to, meta ?? { contentType: 'application/octet-stream' });
  }

  async deleteObject(location: ObjectLocation): Promise<void> {
    await rm(this.objectPath(location), { force: true });
    await rm(this.metaPath(location), { force: true });
  }

  async createSignedDownloadUrl(input: SignedDownloadInput): Promise<SignedDownload> {
    assertValidStorageKey(input.key);
    if (input.bucket === 'quarantine')
      throw new StorageError('objects in quarantine cannot be downloaded', 'quarantined');
    const resolved = resolveContentDisposition(input.contentType, input.contentDisposition);
    const headerValue = contentDispositionHeader(resolved.disposition, input.fileName);
    const expiresIn = clampExpiry(input.expiresInSeconds, this.ttl);
    const expiresAt = new Date(this.now().getTime() + expiresIn * 1000);
    return {
      url: signDevStorageUrl(this.options.appUrl, this.options.signingSecret, {
        op: 'download',
        bucket: input.bucket,
        key: input.key,
        expiresAt,
        contentType: resolved.contentType,
        fileName: input.fileName,
        disposition: resolved.disposition,
      }),
      expiresAt,
      contentDisposition: resolved.disposition,
      contentType: resolved.contentType,
      headerValue,
    };
  }

  /** Headers the dev download route must send (nosniff + the signed disposition). */
  downloadHeaders(params: DevSignedParams): Record<string, string> {
    const resolved = resolveContentDisposition(
      params.contentType ?? 'application/octet-stream',
      params.disposition ?? 'attachment',
    );
    return {
      'Content-Type': resolved.contentType,
      'Content-Disposition': contentDispositionHeader(
        resolved.disposition,
        params.fileName ?? 'download',
      ),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    };
  }

  /** Lists keys in a bucket (development tooling only). */
  async listKeys(bucket: StorageBucket): Promise<string[]> {
    const dir = path.resolve(this.root, bucket);
    const out: string[] = [];
    const walk = async (current: string): Promise<void> => {
      const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (!entry.name.includes('.uploading-'))
          out.push(path.relative(dir, full).split(path.sep).join('/'));
      }
    };
    await walk(dir);
    return out.sort();
  }
}

async function collect(stream: Readable): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  return chunks;
}
