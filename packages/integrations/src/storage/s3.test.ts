import { Readable } from 'node:stream';
import {
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { createStorageProvider, storageConfigFromEnv } from './factory';
import { S3StorageProvider, createS3Client } from './s3';
import { StorageError } from './types';

const buckets = { private: 'sxd-private', quarantine: 'sxd-quarantine' };

function options(transport?: Pick<S3Client, 'send'>) {
  return {
    region: 'us-east-1',
    endpoint: 'http://127.0.0.1:9000',
    forcePathStyle: true,
    credentials: { accessKeyId: 'minio', secretAccessKey: 'minio-secret' },
    buckets,
    signedUrlTtlSeconds: 300,
    transport,
  };
}

/** Records commands and answers with canned outputs; presigning still uses the real (offline) signer. */
function fakeTransport(responses: Record<string, unknown> = {}) {
  const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
  const send = vi.fn(
    async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name;
      sent.push({ name, input: command.input });
      const response = responses[name];
      if (response instanceof Error) throw response;
      return response ?? {};
    },
  );
  return { transport: { send } as unknown as Pick<S3Client, 'send'>, sent };
}

describe('S3StorageProvider presigning', () => {
  it('presigns a size-bound PUT into the quarantine bucket', async () => {
    const provider = new S3StorageProvider(options());
    const intent = await provider.createUploadIntent({
      key: 'org/o/evidence/abcdef12-3456.png',
      contentType: 'image/png',
      sizeBytes: 1234,
      multipart: false,
    });
    expect(intent.kind).toBe('single');
    if (intent.kind !== 'single') return;
    const url = new URL(intent.url);
    expect(url.origin).toBe('http://127.0.0.1:9000');
    expect(url.pathname).toBe('/sxd-quarantine/org/o/evidence/abcdef12-3456.png');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(intent.headers).toEqual({ 'Content-Type': 'image/png' });
    expect(intent.bucket).toBe('quarantine');
  });

  it('presigns downloads with disposition/content-type overrides and never inline for markup', async () => {
    const provider = new S3StorageProvider(options());
    const svg = await provider.createSignedDownloadUrl({
      bucket: 'private',
      key: 'org/o/evidence/abcdef12-3456.svg',
      fileName: 'logo.svg',
      contentType: 'image/svg+xml',
      contentDisposition: 'inline',
      expiresInSeconds: 60,
    });
    const svgUrl = new URL(svg.url);
    expect(svgUrl.pathname).toBe('/sxd-private/org/o/evidence/abcdef12-3456.svg');
    expect(svgUrl.searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="logo.svg"; filename*=UTF-8\'\'logo.svg',
    );
    expect(svgUrl.searchParams.get('response-content-type')).toBe('application/octet-stream');
    expect(svgUrl.searchParams.get('X-Amz-Expires')).toBe('60');
    expect(svg.contentDisposition).toBe('attachment');

    const png = await provider.createSignedDownloadUrl({
      bucket: 'derivatives',
      key: 'org/o/evidence/abcdef12-3456.thumb.webp',
      fileName: 'thumb.webp',
      contentType: 'image/webp',
      contentDisposition: 'inline',
    });
    const pngUrl = new URL(png.url);
    expect(pngUrl.pathname).toBe('/sxd-private/org/o/evidence/abcdef12-3456.thumb.webp'); // derivatives default to the private bucket
    expect(pngUrl.searchParams.get('response-content-disposition')).toMatch(
      /^inline; filename="thumb\.webp"/,
    );
    expect(pngUrl.searchParams.get('response-content-type')).toBe('image/webp');

    await expect(
      provider.createSignedDownloadUrl({
        bucket: 'quarantine',
        key: 'org/o/x/abcdef12-3456.png',
        fileName: 'x',
        contentType: 'image/png',
        contentDisposition: 'inline',
      }),
    ).rejects.toMatchObject({ code: 'quarantined' });
  });

  it('validates keys, bucket configuration and upload targets', async () => {
    const provider = new S3StorageProvider(options());
    await expect(provider.headObject({ bucket: 'private', key: '../x' })).rejects.toMatchObject({
      code: 'invalid_key',
    });
    await expect(
      provider.createUploadIntent({
        bucket: 'private',
        key: 'org/o/x/abcdef12-3456.png',
        contentType: 'image/png',
        sizeBytes: 1,
        multipart: false,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(
      () =>
        new S3StorageProvider({ ...options(), buckets: { private: 'same', quarantine: 'same' } }),
    ).toThrow(/different/);
    expect(() => new S3StorageProvider({ ...options(), endpoint: 'minio:9000' })).toThrow(/http/);
    expect(createS3Client(options())).toBeDefined();
  });
});

describe('S3StorageProvider commands', () => {
  it('creates multipart uploads, presigns parts and completes with sorted parts', async () => {
    const { transport, sent } = fakeTransport({
      CreateMultipartUploadCommand: { UploadId: 'upload-1' },
      CompleteMultipartUploadCommand: { ETag: '"final-3"' },
    });
    const provider = new S3StorageProvider(options(transport));
    const intent = await provider.createUploadIntent({
      key: 'org/o/video/abcdef12-3456.mp4',
      contentType: 'video/mp4',
      sizeBytes: 40_000_000,
      multipart: true,
      partCount: 3,
    });
    expect(intent.kind).toBe('multipart');
    if (intent.kind !== 'multipart') return;
    expect(intent.uploadId).toBe('upload-1');
    expect(intent.partUrls).toHaveLength(3);
    const part2 = new URL(intent.partUrls[1]!.url);
    expect(part2.searchParams.get('partNumber')).toBe('2');
    expect(part2.searchParams.get('uploadId')).toBe('upload-1');
    expect(part2.pathname).toBe('/sxd-quarantine/org/o/video/abcdef12-3456.mp4');
    expect(sent[0]).toEqual({
      name: CreateMultipartUploadCommand.name,
      input: {
        Bucket: 'sxd-quarantine',
        Key: 'org/o/video/abcdef12-3456.mp4',
        ContentType: 'video/mp4',
      },
    });

    const done = await provider.completeMultipart({
      key: 'org/o/video/abcdef12-3456.mp4',
      uploadId: 'upload-1',
      parts: [
        { partNumber: 3, etag: '"c"' },
        { partNumber: 1, etag: '"a"' },
        { partNumber: 2, etag: '"b"' },
      ],
    });
    expect(done.etag).toBe('"final-3"');
    expect(sent[1]).toEqual({
      name: CompleteMultipartUploadCommand.name,
      input: {
        Bucket: 'sxd-quarantine',
        Key: 'org/o/video/abcdef12-3456.mp4',
        UploadId: 'upload-1',
        MultipartUpload: {
          Parts: [
            { PartNumber: 1, ETag: '"a"' },
            { PartNumber: 2, ETag: '"b"' },
            { PartNumber: 3, ETag: '"c"' },
          ],
        },
      },
    });
    await expect(
      provider.createUploadIntent({
        key: 'org/o/v/abcdef12-3456.mp4',
        contentType: 'video/mp4',
        sizeBytes: 1,
        multipart: true,
      }),
    ).rejects.toThrow(/partCount/);
  });

  it('heads, copies, puts and streams objects through the client', async () => {
    const notFound = Object.assign(new Error('NotFound'), {
      name: 'NotFound',
      $metadata: { httpStatusCode: 404 },
    });
    const { transport, sent } = fakeTransport({
      HeadObjectCommand: {
        ContentLength: 10,
        ContentType: 'image/png',
        ETag: '"e"',
        LastModified: new Date('2026-09-23T00:00:00Z'),
      },
      PutObjectCommand: { ETag: '"put"' },
      GetObjectCommand: { Body: Readable.from([Buffer.from('data')]) },
    });
    const provider = new S3StorageProvider(options(transport));
    expect(
      await provider.headObject({ bucket: 'private', key: 'org/o/x/abcdef12-3456.png' }),
    ).toEqual({
      sizeBytes: 10,
      contentType: 'image/png',
      etag: '"e"',
      lastModified: new Date('2026-09-23T00:00:00Z'),
    });
    expect(sent[0]).toEqual({
      name: HeadObjectCommand.name,
      input: { Bucket: 'sxd-private', Key: 'org/o/x/abcdef12-3456.png' },
    });

    await provider.copyObject(
      { bucket: 'quarantine', key: 'org/o/x/abcdef12-3456.png' },
      { bucket: 'private', key: 'org/o/x/abcdef12-3456.png' },
    );
    expect(sent[1]).toEqual({
      name: CopyObjectCommand.name,
      input: {
        Bucket: 'sxd-private',
        Key: 'org/o/x/abcdef12-3456.png',
        CopySource: 'sxd-quarantine/org/o/x/abcdef12-3456.png',
        MetadataDirective: 'COPY',
      },
    });

    expect(
      await provider.putObject(
        { bucket: 'derivatives', key: 'org/o/x/abcdef12-3456.thumb.webp' },
        Buffer.from('abc'),
        'image/webp',
      ),
    ).toEqual({ etag: '"put"' });
    expect(sent[2]).toMatchObject({
      name: PutObjectCommand.name,
      input: { Bucket: 'sxd-private', ContentType: 'image/webp', ContentLength: 3 },
    });
    await expect(
      provider.putObject(
        { bucket: 'private', key: 'org/o/x/abcdef12-3456.bin' },
        Readable.from([]),
        'application/octet-stream',
      ),
    ).rejects.toThrow(/contentLength/);

    const stream = await provider.getObjectStream({
      bucket: 'private',
      key: 'org/o/x/abcdef12-3456.png',
    });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(chunks).toString()).toBe('data');

    const missing = new S3StorageProvider(
      options(fakeTransport({ HeadObjectCommand: notFound, GetObjectCommand: notFound }).transport),
    );
    expect(
      await missing.headObject({ bucket: 'private', key: 'org/o/x/abcdef12-0000.png' }),
    ).toBeNull();
    await expect(
      missing.getObjectStream({ bucket: 'private', key: 'org/o/x/abcdef12-0000.png' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('storage factory', () => {
  it('maps environment variables and refuses local-dev outside development/test', () => {
    const s3 = storageConfigFromEnv({
      APP_ENV: 'production',
      STORAGE_PROVIDER: 's3',
      S3_ENDPOINT: 'https://s3.eu-west-1.amazonaws.com',
      S3_REGION: 'eu-west-1',
      S3_BUCKET_PRIVATE: 'p',
      S3_BUCKET_QUARANTINE: 'q',
      S3_FORCE_PATH_STYLE: 'false',
    });
    expect(s3.s3).toMatchObject({
      region: 'eu-west-1',
      forcePathStyle: false,
      credentials: null,
      buckets: { private: 'p', quarantine: 'q' },
    });
    expect(createStorageProvider(s3).id).toBe('s3');

    const dev = storageConfigFromEnv({
      APP_ENV: 'test',
      STORAGE_PROVIDER: 'local-dev',
      APP_URL: 'http://localhost:3000',
      AUTH_SECRET: 'a-long-enough-development-secret',
    });
    expect(createStorageProvider(dev).id).toBe('local-dev');
    expect(() => createStorageProvider({ ...dev, appEnv: 'production' })).toThrow(StorageError);
  });
});
