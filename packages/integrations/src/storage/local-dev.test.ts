import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalDevStorageProvider, signDevStorageUrl, verifyDevStorageUrl } from './local-dev';
import { StorageError } from './types';

const secret = 'dev-storage-signing-secret-0123456789';
const appUrl = 'http://localhost:3000';
let root: string;
let provider: LocalDevStorageProvider;
const now = new Date('2026-09-23T10:00:00Z');

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'sxd-local-dev-'));
  provider = new LocalDevStorageProvider({
    appEnv: 'test',
    root,
    appUrl,
    signingSecret: secret,
    now: () => now,
  });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('local-dev signed URLs', () => {
  it('signs, verifies, and rejects tampering and expiry', () => {
    const url = signDevStorageUrl(appUrl, secret, {
      op: 'download',
      bucket: 'private',
      key: 'org/o/evidence/abc12345.png',
      expiresAt: new Date(now.getTime() + 300_000),
      contentType: 'image/png',
      fileName: 'site.png',
      disposition: 'inline',
    });
    expect(url).toContain('/api/v1/dev/storage/download?');
    const ok = verifyDevStorageUrl(url, secret, now);
    expect(ok).toMatchObject({
      ok: true,
      params: {
        op: 'download',
        bucket: 'private',
        key: 'org/o/evidence/abc12345.png',
        disposition: 'inline',
      },
    });
    expect(verifyDevStorageUrl(url.replace('abc12345', 'zzz12345'), secret, now)).toEqual({
      ok: false,
      reason: 'bad signature',
    });
    expect(verifyDevStorageUrl(url, 'another-secret-long-enough-0000', now)).toEqual({
      ok: false,
      reason: 'bad signature',
    });
    expect(verifyDevStorageUrl(url, secret, new Date(now.getTime() + 301_000))).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(verifyDevStorageUrl(url.replace('/download?', '/upload?'), secret, now)).toEqual({
      ok: false,
      reason: 'path/op mismatch',
    });
    expect(verifyDevStorageUrl(url.replace('sig=', 'sigx='), secret, now)).toEqual({
      ok: false,
      reason: 'missing signature',
    });
  });

  it('refuses production and weak secrets', () => {
    expect(
      () => new LocalDevStorageProvider({ appEnv: 'production', appUrl, signingSecret: secret }),
    ).toThrow(/development adapter/);
    expect(
      () => new LocalDevStorageProvider({ appEnv: 'test', appUrl, signingSecret: 'short' }),
    ).toThrow(/signing secret/);
  });
});

describe('local-dev objects', () => {
  const key = 'org/o/evidence/abcdef12-3456.png';

  it('uploads through a signed intent, enforces the signed size, and promotes out of quarantine', async () => {
    const intent = await provider.createUploadIntent({
      key,
      contentType: 'image/png',
      sizeBytes: 4,
      multipart: false,
    });
    expect(intent.kind).toBe('single');
    if (intent.kind !== 'single') return;
    expect(intent.bucket).toBe('quarantine');
    expect(intent.headers).toEqual({ 'Content-Type': 'image/png' });
    const verified = provider.verifySignedRequest(intent.url);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    await expect(
      provider.writeUploadedObject(verified.params, Buffer.from('12345')),
    ).rejects.toThrow(/does not match/);
    const written = await provider.writeUploadedObject(
      verified.params,
      Readable.from([Buffer.from('12'), Buffer.from('34')]),
    );
    expect(written.sizeBytes).toBe(4);
    expect(await provider.headObject({ bucket: 'quarantine', key })).toMatchObject({
      sizeBytes: 4,
      contentType: 'image/png',
    });
    expect(await provider.headObject({ bucket: 'private', key })).toBeNull();

    await expect(
      provider.createSignedDownloadUrl({
        bucket: 'quarantine',
        key,
        fileName: 'x.png',
        contentType: 'image/png',
        contentDisposition: 'inline',
      }),
    ).rejects.toMatchObject({ code: 'quarantined' });

    await provider.copyObject({ bucket: 'quarantine', key }, { bucket: 'private', key });
    await provider.deleteObject({ bucket: 'quarantine', key });
    expect(await provider.headObject({ bucket: 'quarantine', key })).toBeNull();
    const stream = await provider.getObjectStream({ bucket: 'private', key });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(chunks).toString()).toBe('1234');

    const download = await provider.createSignedDownloadUrl({
      bucket: 'private',
      key,
      fileName: 'site.svg',
      contentType: 'image/svg+xml',
      contentDisposition: 'inline',
    });
    expect(download.contentDisposition).toBe('attachment');
    expect(download.contentType).toBe('application/octet-stream');
    const params = provider.verifySignedRequest(download.url);
    expect(params.ok && provider.downloadHeaders(params.params)['Content-Disposition']).toContain(
      'attachment; filename="site.svg"',
    );
    expect(params.ok && provider.downloadHeaders(params.params)['X-Content-Type-Options']).toBe(
      'nosniff',
    );
  });

  it('assembles multipart uploads and verifies part etags', async () => {
    const mpKey = 'org/o/video/abcdef12-9999.mp4';
    const intent = await provider.createUploadIntent({
      key: mpKey,
      contentType: 'video/mp4',
      sizeBytes: 6,
      multipart: true,
      partCount: 2,
    });
    expect(intent.kind).toBe('multipart');
    if (intent.kind !== 'multipart') return;
    expect(intent.partUrls.map((p) => p.partNumber)).toEqual([1, 2]);
    const etags: string[] = [];
    for (const part of intent.partUrls) {
      const verified = provider.verifySignedRequest(part.url);
      expect(verified.ok).toBe(true);
      if (!verified.ok) return;
      const { etag } = await provider.writeUploadedPart(
        verified.params,
        Buffer.from(part.partNumber === 1 ? 'abc' : 'def'),
      );
      etags.push(etag);
    }
    await expect(
      provider.completeMultipart({
        key: mpKey,
        uploadId: intent.uploadId,
        parts: [
          { partNumber: 1, etag: '"wrong"' },
          { partNumber: 2, etag: etags[1]! },
        ],
      }),
    ).rejects.toThrow(/etag mismatch/);
    const done = await provider.completeMultipart({
      key: mpKey,
      uploadId: intent.uploadId,
      parts: [
        { partNumber: 2, etag: etags[1]! },
        { partNumber: 1, etag: etags[0]! },
      ],
    });
    expect(done.etag).toMatch(/-2"$/);
    expect(await provider.headObject({ bucket: 'quarantine', key: mpKey })).toMatchObject({
      sizeBytes: 6,
      contentType: 'video/mp4',
    });
    await expect(
      provider.abortMultipart({ key: mpKey, uploadId: intent.uploadId }),
    ).resolves.toBeUndefined();
    expect(await provider.listKeys('quarantine')).toContain(mpKey);
  });

  it('rejects unsafe keys and non-quarantine upload targets', async () => {
    await expect(
      provider.headObject({ bucket: 'private', key: '../escape' }),
    ).rejects.toBeInstanceOf(StorageError);
    await expect(
      provider.createUploadIntent({
        bucket: 'private',
        key: 'org/o/p/abcdef12-3456.png',
        contentType: 'image/png',
        sizeBytes: 1,
        multipart: false,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
