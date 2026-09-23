import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, schema } from '@simplexd/db';
import { connectTestDatabases, uniqueSuffix, type TestDatabases } from '@simplexd/db/testing';
import { DevMalwareScanner } from '@simplexd/integrations/scanner';
import { LocalDevStorageProvider } from '@simplexd/integrations/storage';
import type { FilePurpose } from '@simplexd/contracts';
import type { RequestIdentity } from '@/lib/auth/session';
import { customerIdentity, staffIdentity } from '@/testing/identity';
import {
  deriveFileObject,
  scanFileObject,
  type MediaDeps,
} from '../../../../worker/src/handlers/media';
import { GET as publicMedia } from '@/app/media/[id]/route';
import { setPublicApproval } from '@/server/files/approval';
import { finalizeUpload } from '@/server/files/finalize';
import { createUploadIntent } from '@/server/files/intents';
import { setStorageForTests } from '@/server/files/storage';
import { listContentMedia, resolvePublicMedia } from './media';

/**
 * Public content media: only content_media files that are clean, promoted
 * and approved (file + media asset) are served, as WebP derivatives with
 * long-cache, nosniff and inline headers. Private purposes and unapproved
 * files are never served, whatever the caller knows.
 */

let dbs: TestDatabases;
let storage: LocalDevStorageProvider;
let storageRoot: string;
let deps: MediaDeps;
const sfx = uniqueSuffix();
const ids = {
  editor: `media_editor_${sfx}`,
  approver: `media_approver_${sfx}`,
  customer: `media_customer_${sfx}`,
  org: `media_org_${sfx}`,
};

const editor = () =>
  staffIdentity({
    userId: ids.editor,
    email: `${ids.editor}@example.test`,
    roles: ['content_editor'],
  });
const approver = () =>
  staffIdentity({
    userId: ids.approver,
    email: `${ids.approver}@example.test`,
    roles: ['content_editor'],
  });
const customer = () =>
  customerIdentity({
    userId: ids.customer,
    email: `${ids.customer}@example.test`,
    organizationId: ids.org,
  });

async function pngBytes(): Promise<Buffer> {
  return sharp({
    create: { width: 48, height: 32, channels: 3, background: { r: 10, g: 120, b: 90 } },
  })
    .png()
    .toBuffer();
}

/** Intent → PUT through the adapter → finalise → scan → derive: a clean image with a web variant. */
async function cleanImage(identity: RequestIdentity, purpose: FilePurpose, name = 'photo.png') {
  const bytes = await pngBytes();
  const intent = await createUploadIntent(identity, {
    purpose,
    fileName: name,
    declaredMime: 'image/png',
    sizeBytes: bytes.length,
  });
  if (intent.upload.kind !== 'single') throw new Error('unreachable');
  const verified = storage.verifySignedRequest(intent.upload.url);
  if (!verified.ok) throw new Error(verified.reason);
  await storage.writeUploadedObject(verified.params, bytes);
  await finalizeUpload(identity, intent.fileId, {});
  expect((await scanFileObject(deps, intent.fileId)).status).toBe('clean');
  expect((await deriveFileObject(deps, intent.fileId)).status).toBe('done');
  return intent.fileId;
}

function get(
  id: string,
  init: { query?: string; headers?: Record<string, string>; method?: string } = {},
) {
  return publicMedia(
    new Request(`http://localhost:3000/media/${id}${init.query ?? ''}`, {
      method: init.method ?? 'GET',
      headers: init.headers,
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeAll(async () => {
  dbs = connectTestDatabases();
  storageRoot = await mkdtemp(path.join(os.tmpdir(), 'sxd-media-'));
  storage = new LocalDevStorageProvider({
    appEnv: 'test',
    root: storageRoot,
    appUrl: 'http://localhost:3000',
    signingSecret: 'test-secret-test-secret-test-secret-test-secret',
  });
  setStorageForTests(storage);
  deps = {
    db: dbs.app,
    storage,
    scanner: new DevMalwareScanner({ appEnv: 'test' }),
    log: pino({ level: 'silent' }),
  };
  await dbs.owner.insert(schema.user).values(
    [ids.editor, ids.approver, ids.customer].map((id) => ({
      id,
      name: id,
      email: `${id}@example.test`,
    })),
  );
  await dbs.owner.insert(schema.staffRoles).values([
    { userId: ids.editor, role: 'content_editor' },
    { userId: ids.approver, role: 'content_editor' },
  ]);
  await dbs.owner.insert(schema.organization).values({ id: ids.org, name: 'Org', slug: ids.org });
  await dbs.owner.insert(schema.member).values({
    id: `m_${ids.customer}`,
    organizationId: ids.org,
    userId: ids.customer,
    role: 'owner',
  });
});

afterAll(async () => {
  setStorageForTests(null);
  await closeDb();
  await dbs.close();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('public media route', () => {
  it('never serves private purposes, even when approved for public use, nor unknown ids', async () => {
    const orgFile = await cleanImage(customer(), 'org_document', 'contract-scan.png');
    // A staff approval of an organisation document is allowed by the file pipeline…
    const approved = await setPublicApproval(approver(), orgFile, {
      approved: true,
      altText: 'Scan',
      rightsConfirmed: true,
    });
    expect(approved.mediaAsset?.approvedForPublic).toBe(true);
    // …but the public route only serves content media.
    const res = await get(approved.mediaAsset!.id);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await resolvePublicMedia(approved.mediaAsset!.id, 'web')).toBeNull();
    expect((await get('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await get('not-a-uuid')).status).toBe(404);
    // Never listed for the content picker either.
    const listing = await listContentMedia(editor());
    expect(listing.items.some((i) => i.fileId === orgFile)).toBe(false);
  });

  it('never serves content media before approval, and stops immediately after revocation', async () => {
    const fileId = await cleanImage(editor(), 'content_media', 'hero.png');
    // Pending for the picker, with the honest state and uploader.
    const before = await listContentMedia(approver());
    expect(before.pending.find((p) => p.fileId === fileId)).toMatchObject({
      status: 'clean',
      hasWebVariant: true,
      ownerUserId: ids.editor,
    });
    // The uploader cannot approve their own image.
    await expect(
      setPublicApproval(editor(), fileId, {
        approved: true,
        altText: 'Hero',
        rightsConfirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const approved = await setPublicApproval(approver(), fileId, {
      approved: true,
      altText: 'Hero image',
      rightsConfirmed: true,
    });
    const assetId = approved.mediaAsset!.id;
    expect((await get(assetId)).status).toBe(200);

    const revoked = await setPublicApproval(approver(), fileId, { approved: false });
    expect(revoked.file.isPublicApproved).toBe(false);
    // The resolution cache was invalidated by the revocation.
    expect((await get(assetId)).status).toBe(404);
    const after = await listContentMedia(approver());
    expect(after.items.some((i) => i.id === assetId)).toBe(false);
    expect(after.pending.some((p) => p.fileId === fileId)).toBe(true);
  });

  it('serves an approved content image as a WebP derivative with long-cache, nosniff and inline headers', async () => {
    const fileId = await cleanImage(editor(), 'content_media', 'site plan.png');
    const { mediaAsset } = await setPublicApproval(approver(), fileId, {
      approved: true,
      altText: 'Site plan',
      rightsConfirmed: true,
      caption: 'Plot 4',
    });
    const assetId = mediaAsset!.id;

    const listing = await listContentMedia(editor());
    const item = listing.items.find((i) => i.id === assetId)!;
    expect(item).toMatchObject({
      publicUrl: `/media/${assetId}`,
      thumbUrl: `/media/${assetId}?variant=thumb`,
      altText: 'Site plan',
      rightsConfirmed: true,
    });

    const res = await get(assetId);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('content-disposition')).toMatch(
      /^inline; filename="site plan\.web\.webp"/,
    );
    expect(res.headers.get('cache-control')).toBe(
      'public, max-age=86400, stale-while-revalidate=604800',
    );
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    const etag = res.headers.get('etag')!;
    expect(etag).toMatch(/^"[0-9a-f]{32}-web"$/);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(Number(res.headers.get('content-length')));
    // RIFF....WEBP magic: the bytes really are the derivative, never the PNG original.
    expect(body.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(body.subarray(8, 12).toString('ascii')).toBe('WEBP');
    const [file] = await dbs.owner
      .select()
      .from(schema.fileObjects)
      .where(eq(schema.fileObjects.id, fileId));
    expect(body.length).not.toBe(file!.sizeBytes);

    const cached = await get(assetId, { headers: { 'if-none-match': etag } });
    expect(cached.status).toBe(304);

    const thumb = await get(assetId, { query: '?variant=thumb' });
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('etag')).toMatch(/-thumb"$/);
    expect((await get(assetId, { query: '?variant=original' })).status).toBe(404);

    const head = await get(assetId, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe('image/webp');
  });
});
