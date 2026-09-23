import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalDevStorageProvider } from './local-dev';
import {
  expectedObjects,
  listBuckets,
  reconcileStorage,
  type FileObjectLike,
  type StorageProvider,
} from './index';

const row = (
  over: Partial<FileObjectLike> & Pick<FileObjectLike, 'id' | 'storageKey'>,
): FileObjectLike => ({
  bucket: 'private',
  status: 'clean',
  derivatives: null,
  deletedAt: null,
  ...over,
});

describe('expectedObjects', () => {
  it('derives originals and derivative keys, marking what must exist', () => {
    const rows: FileObjectLike[] = [
      row({
        id: 'f1',
        storageKey: 'org/a/evidence/f1.jpg',
        derivatives: { web: 'org/a/evidence/f1.web.webp', thumb: 'org/a/evidence/f1.thumb.webp' },
      }),
      row({ id: 'f2', storageKey: 'org/a/video/f2.mp4', derivatives: { video: 'original' } }),
      row({
        id: 'f3',
        storageKey: 'org/a/doc/f3.pdf',
        status: 'pending_upload',
        bucket: 'quarantine',
      }),
      row({ id: 'f4', storageKey: 'org/a/doc/f4.pdf', status: 'infected', bucket: 'quarantine' }),
      row({ id: 'f5', storageKey: 'org/a/doc/f5.pdf', status: 'deleted', deletedAt: new Date() }),
      row({
        id: 'f6',
        storageKey: 'org/a/img/f6.png',
        derivatives: { error: 'sharp: bad header / corrupt' },
      }),
    ];
    const expected = expectedObjects(rows);
    expect(expected.map((e) => [e.bucket, e.key, e.role, e.required])).toEqual([
      ['private', 'org/a/evidence/f1.jpg', 'original', true],
      ['derivatives', 'org/a/evidence/f1.web.webp', 'derivative', true],
      ['derivatives', 'org/a/evidence/f1.thumb.webp', 'derivative', true],
      ['private', 'org/a/video/f2.mp4', 'original', true],
      ['quarantine', 'org/a/doc/f3.pdf', 'original', false],
      ['quarantine', 'org/a/doc/f4.pdf', 'original', true],
      ['private', 'org/a/doc/f5.pdf', 'original', false],
      ['private', 'org/a/img/f6.png', 'original', true],
    ]);
  });
});

describe('reconcileStorage', () => {
  it('reports missing objects, orphans, lingering objects and pending uploads, ignoring probe keys', () => {
    const rows: FileObjectLike[] = [
      row({
        id: 'ok',
        storageKey: 'org/a/evidence/ok.jpg',
        derivatives: { web: 'org/a/evidence/ok.web.webp' },
      }),
      row({ id: 'gone', storageKey: 'org/a/evidence/gone.jpg' }),
      row({
        id: 'noweb',
        storageKey: 'org/a/evidence/noweb.jpg',
        derivatives: { web: 'org/a/evidence/noweb.web.webp' },
      }),
      row({
        id: 'waiting',
        storageKey: 'org/a/doc/waiting.pdf',
        status: 'pending_upload',
        bucket: 'quarantine',
      }),
      row({
        id: 'removed',
        storageKey: 'org/a/doc/removed.pdf',
        status: 'deleted',
        deletedAt: '2026-09-01T00:00:00Z',
      }),
    ];
    const report = reconcileStorage(rows, [
      {
        bucket: 'private',
        keys: [
          'org/a/evidence/ok.jpg',
          'org/a/evidence/noweb.jpg',
          'org/a/doc/removed.pdf',
          'org/zzz/evidence/unknown.jpg',
          'healthchecks/integration-probe.txt',
        ],
      },
      { bucket: 'quarantine', keys: ['org/a/doc/stray.pdf'] },
      { bucket: 'derivatives', keys: ['org/a/evidence/ok.web.webp'] },
    ]);
    expect(report.missing.map((m) => `${m.bucket}/${m.key}`)).toEqual([
      'private/org/a/evidence/gone.jpg',
      'derivatives/org/a/evidence/noweb.web.webp',
    ]);
    expect(report.orphans).toEqual([
      { bucket: 'private', key: 'org/zzz/evidence/unknown.jpg' },
      { bucket: 'quarantine', key: 'org/a/doc/stray.pdf' },
    ]);
    expect(report.lingering.map((l) => l.fileId)).toEqual(['removed']);
    expect(report.pending).toBe(1);
    expect(report.summary).toEqual({ rows: 5, expected: 5, present: 4, missing: 2, orphans: 2 });
    expect(report.buckets).toEqual([
      { bucket: 'private', objects: 5, expected: 3 },
      { bucket: 'quarantine', objects: 1, expected: 0 },
      { bucket: 'derivatives', objects: 1, expected: 2 },
    ]);
    expect(report.ignoredPrefixes).toEqual(['healthchecks/']);
  });

  it('is clean when every required object exists and nothing else does', () => {
    const rows = [row({ id: 'a', storageKey: 'shared/avatar/a.png' })];
    const report = reconcileStorage(rows, [{ bucket: 'private', keys: ['shared/avatar/a.png'] }]);
    expect(report.summary).toEqual({ rows: 1, expected: 1, present: 1, missing: 0, orphans: 0 });
    expect(report.orphans).toEqual([]);
    expect(report.missing).toEqual([]);
  });
});

describe('listBuckets', () => {
  let root: string;
  let provider: LocalDevStorageProvider;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'sxd-reconcile-'));
    provider = new LocalDevStorageProvider({
      appEnv: 'test',
      root,
      appUrl: 'http://localhost:3000',
      signingSecret: 'dev-storage-signing-secret-0123456789',
    });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lists the local-dev store per bucket and feeds the reconciliation', async () => {
    await provider.putObject(
      { bucket: 'private', key: 'org/a/evidence/f1.jpg' },
      Buffer.from('x'),
      'image/jpeg',
    );
    await provider.putObject(
      { bucket: 'derivatives', key: 'org/a/evidence/f1.web.webp' },
      Buffer.from('x'),
      'image/webp',
    );
    await provider.putObject(
      { bucket: 'quarantine', key: 'org/a/doc/stray.pdf' },
      Buffer.from('x'),
      'application/pdf',
    );
    const listings = await listBuckets(provider);
    expect(listings).toEqual([
      { bucket: 'private', keys: ['org/a/evidence/f1.jpg'], physical: 'private' },
      { bucket: 'quarantine', keys: ['org/a/doc/stray.pdf'], physical: 'quarantine' },
      { bucket: 'derivatives', keys: ['org/a/evidence/f1.web.webp'], physical: 'derivatives' },
    ]);
    const report = reconcileStorage(
      [
        row({
          id: 'f1',
          storageKey: 'org/a/evidence/f1.jpg',
          derivatives: { web: 'org/a/evidence/f1.web.webp' },
        }),
      ],
      listings,
    );
    expect(report.summary).toEqual({ rows: 1, expected: 2, present: 2, missing: 0, orphans: 1 });
    expect(report.orphans).toEqual([{ bucket: 'quarantine', key: 'org/a/doc/stray.pdf' }]);
  });

  it('attributes a shared physical bucket to both logical buckets (S3 without a derivatives bucket)', async () => {
    let calls = 0;
    const fake = {
      listKeys: async (bucket: string) => {
        calls += 1;
        return bucket === 'quarantine' ? ['q/1'] : ['p/1', 'p/1.web.webp'];
      },
    } as unknown as StorageProvider;
    const listings = await listBuckets(fake, (b) =>
      b === 'quarantine' ? 'sxd-quarantine' : 'sxd-private',
    );
    expect(calls).toBe(2);
    expect(listings).toEqual([
      { bucket: 'private', keys: ['p/1', 'p/1.web.webp'], physical: 'sxd-private' },
      { bucket: 'quarantine', keys: ['q/1'], physical: 'sxd-quarantine' },
      { bucket: 'derivatives', keys: ['p/1', 'p/1.web.webp'], physical: 'sxd-private' },
    ]);
    const report = reconcileStorage(
      [row({ id: 'f', storageKey: 'p/1', derivatives: { web: 'p/1.web.webp' } })],
      listings,
    );
    expect(report.orphans).toEqual([{ bucket: 'quarantine', key: 'q/1' }]);
    expect(report.missing).toEqual([]);
  });
});
