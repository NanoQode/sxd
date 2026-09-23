import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import pino from 'pino';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, schema, type Database } from '@simplexd/db';
import {
  connectTestDatabases,
  resetDatabase,
  uniqueSuffix,
  type TestDatabases,
} from '@simplexd/db/testing';
import type { OrgRole, StaffRole } from '@simplexd/domain/authz';
import { DevMalwareScanner, EICAR_TEST_STRING } from '@simplexd/integrations/scanner';
import {
  LocalDevStorageProvider,
  sha256HexSync,
  verifyDevStorageUrl,
} from '@simplexd/integrations/storage';
import type { UploadIntentCreate } from '@simplexd/contracts';
import type { RequestIdentity } from '@/lib/auth/session';
import {
  deriveFileObject,
  scanFileObject,
  type MediaDeps,
} from '../../../../worker/src/handlers/media';
import { setPublicApproval } from './approval';
import { issueDownload } from './download';
import { finalizeUpload } from './finalize';
import { createGrant, revokeGrant } from './grants';
import { createUploadIntent } from './intents';
import { getFile, listFilesForEntity } from './queries';
import { setStorageForTests } from './storage';

/**
 * End-to-end pipeline through the local-dev storage adapter and the dev
 * scanner: intent → PUT (adapter called directly, as the dev route does) →
 * finalise → scan job → derivatives → signed download, plus the refusal paths
 * of acceptance scenario 12.
 */

const SIGNING_SECRET = 'test-secret-test-secret-test-secret-test-secret';
const APP_URL = 'http://localhost:3000';

let dbs: TestDatabases;
let storage: LocalDevStorageProvider;
let storageRoot: string;
let deps: MediaDeps;
let ids: {
  orgA: string;
  orgB: string;
  ownerA: string;
  memberA: string;
  ownerB: string;
  ops: string;
  superAdmin: string;
  inspector: string;
  partner: string;
  projectA: string;
};

function identityFor(
  userId: string,
  opts: {
    staffRoles?: StaffRole[];
    memberships?: Array<{ organizationId: string; role: OrgRole }>;
    isPartner?: boolean;
  } = {},
): RequestIdentity {
  const memberships = opts.memberships ?? [];
  const activeOrganizationId = memberships[0]?.organizationId ?? null;
  const staffRoles = opts.staffRoles ?? [];
  const now = new Date();
  return {
    session: {
      user: {
        id: userId,
        name: userId,
        email: `${userId}@example.test`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
      session: {
        id: `sess_${userId}`,
        userId,
        token: `tok_${userId}`,
        expiresAt: new Date(now.getTime() + 3_600_000),
        createdAt: now,
        updatedAt: now,
        activeOrganizationId,
      },
    } as unknown as RequestIdentity['session'],
    actor: {
      userId,
      staffRoles,
      memberships,
      activeOrganizationId,
      isPartner: opts.isPartner ?? false,
      mfaVerified: true,
      impersonation: null,
      flags: {},
    },
    ctx: { userId, organizationId: activeOrganizationId, staff: staffRoles.length > 0 },
    profile: null,
    featureFlags: {},
  };
}

const ownerA = () =>
  identityFor(ids.ownerA, { memberships: [{ organizationId: ids.orgA, role: 'owner' }] });
const memberA = () =>
  identityFor(ids.memberA, { memberships: [{ organizationId: ids.orgA, role: 'member' }] });
const ownerB = () =>
  identityFor(ids.ownerB, { memberships: [{ organizationId: ids.orgB, role: 'owner' }] });
const ops = () => identityFor(ids.ops, { staffRoles: ['operations_manager'] });
const superAdmin = () => identityFor(ids.superAdmin, { staffRoles: ['super_admin'] });
const inspector = () => identityFor(ids.inspector, { staffRoles: ['inspector'] });
const partner = () => identityFor(ids.partner, { isPartner: true });

function errorCode(err: unknown): string | undefined {
  const e = err as { code?: string; name?: string };
  return e?.name === 'AuthorizationError' ? 'forbidden' : e?.code;
}

async function pngBytes(width = 64, height = 40): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } } })
    .png()
    .toBuffer();
}

/** Intent + direct PUT through the adapter (what the dev route does with the signed URL). */
async function upload(
  identity: RequestIdentity,
  bytes: Buffer,
  input: Partial<UploadIntentCreate> & { fileName: string; declaredMime: string },
) {
  const intent = await createUploadIntent(identity, {
    purpose: 'org_document',
    sizeBytes: bytes.length,
    ...input,
  } as UploadIntentCreate);
  expect(intent.upload.kind).toBe('single');
  if (intent.upload.kind !== 'single') throw new Error('unreachable');
  const verified = storage.verifySignedRequest(intent.upload.url);
  expect(verified.ok).toBe(true);
  if (!verified.ok) throw new Error(verified.reason);
  await storage.writeUploadedObject(verified.params, bytes);
  return intent;
}

async function fileRow(owner: Database, id: string) {
  const [row] = await owner.select().from(schema.fileObjects).where(eq(schema.fileObjects.id, id));
  return row!;
}

beforeAll(async () => {
  dbs = connectTestDatabases();
  await resetDatabase(dbs.owner);
  storageRoot = await mkdtemp(path.join(os.tmpdir(), 'sxd-files-'));
  storage = new LocalDevStorageProvider({
    appEnv: 'test',
    root: storageRoot,
    appUrl: APP_URL,
    signingSecret: SIGNING_SECRET,
  });
  setStorageForTests(storage);
  deps = {
    db: dbs.app,
    storage,
    scanner: new DevMalwareScanner({ appEnv: 'test' }),
    log: pino({ level: 'silent' }),
  };
  const s = uniqueSuffix();
  ids = {
    orgA: `org_a_${s}`,
    orgB: `org_b_${s}`,
    ownerA: `owner_a_${s}`,
    memberA: `member_a_${s}`,
    ownerB: `owner_b_${s}`,
    ops: `ops_${s}`,
    superAdmin: `admin_${s}`,
    inspector: `inspector_${s}`,
    partner: `partner_${s}`,
    projectA: '',
  };
  const owner = dbs.owner;
  await owner
    .insert(schema.user)
    .values(
      [
        ids.ownerA,
        ids.memberA,
        ids.ownerB,
        ids.ops,
        ids.superAdmin,
        ids.inspector,
        ids.partner,
      ].map((id) => ({ id, name: id, email: `${id}@example.test` })),
    );
  await owner.insert(schema.organization).values([
    { id: ids.orgA, name: 'Org A', slug: ids.orgA },
    { id: ids.orgB, name: 'Org B', slug: ids.orgB },
  ]);
  await owner.insert(schema.member).values([
    { id: `m_${ids.ownerA}`, organizationId: ids.orgA, userId: ids.ownerA, role: 'owner' },
    { id: `m_${ids.memberA}`, organizationId: ids.orgA, userId: ids.memberA, role: 'member' },
    { id: `m_${ids.ownerB}`, organizationId: ids.orgB, userId: ids.ownerB, role: 'owner' },
  ]);
  await owner.insert(schema.staffRoles).values([
    { userId: ids.ops, role: 'operations_manager' },
    { userId: ids.superAdmin, role: 'super_admin' },
    { userId: ids.inspector, role: 'inspector' },
  ]);
  await owner.insert(schema.partnerProfiles).values({
    userId: ids.partner,
    partnerType: 'surveyor',
    displayName: 'Partner',
    verificationStatus: 'verified',
  });
  const [project] = await owner
    .insert(schema.projects)
    .values({ organizationId: ids.orgA, name: 'Project A', kind: 'construction_monitoring' })
    .returning({ id: schema.projects.id });
  ids.projectA = project!.id;
});

afterAll(async () => {
  setStorageForTests(null);
  await closeDb();
  await dbs.close();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('upload pipeline', () => {
  it('runs intent → upload → finalise → scan → derivatives → signed download for a clean image', async () => {
    const bytes = await pngBytes();
    const intent = await upload(ownerA(), bytes, {
      fileName: 'site.png',
      declaredMime: 'image/png',
      sha256: sha256HexSync(bytes),
    });
    const pending = await fileRow(dbs.owner, intent.fileId);
    expect(pending.status).toBe('pending_upload');
    expect(pending.bucket).toBe('quarantine');
    expect(pending.storageKey).toBe(
      `org/${ids.orgA.replace(/_/g, '-')}/org-document/${intent.fileId}.png`,
    );
    expect(pending.retentionUntil).not.toBeNull();
    expect(new Date(intent.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // Not downloadable before the scan.
    await expect(issueDownload(ownerA(), intent.fileId, {})).rejects.toSatisfy(
      (e) => errorCode(e) === 'file_quarantined',
    );

    const finalized = await finalizeUpload(ownerA(), intent.fileId, {});
    expect(finalized.outcome).toBe('scanning');
    expect(finalized.file.status).toBe('scanning');
    expect(finalized.file.checksumSha256).toBe(sha256HexSync(bytes));
    expect(finalized.file.detectedMime).toBe('image/png');
    const outbox = await dbs.owner
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.aggregateId, intent.fileId));
    expect(outbox.map((o) => o.eventType)).toEqual(['file.uploaded']);
    await expect(issueDownload(ownerA(), intent.fileId, {})).rejects.toSatisfy(
      (e) => errorCode(e) === 'file_quarantined',
    );

    const scan = await scanFileObject(deps, intent.fileId);
    expect(scan.status).toBe('clean');
    const clean = await fileRow(dbs.owner, intent.fileId);
    expect(clean.status).toBe('clean');
    expect(clean.bucket).toBe('private');
    expect(await storage.headObject({ bucket: 'quarantine', key: clean.storageKey })).toBeNull();
    expect(
      (await storage.headObject({ bucket: 'private', key: clean.storageKey }))?.sizeBytes,
    ).toBe(bytes.length);
    const deriveJobs = await dbs.owner
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.type, 'files.derive'));
    expect(deriveJobs.some((j) => (j.payload as { fileId: string }).fileId === intent.fileId)).toBe(
      true,
    );

    const derived = await deriveFileObject(deps, intent.fileId);
    expect(derived.status).toBe('done');
    const withVariants = await fileRow(dbs.owner, intent.fileId);
    expect(withVariants.derivatives?.['web']).toBe(
      `org/${ids.orgA.replace(/_/g, '-')}/org-document/${intent.fileId}.web.webp`,
    );
    expect(withVariants.derivatives?.['thumb']).toContain('.thumb.webp');
    // The original is untouched; derivatives are WebP without EXIF.
    expect(
      (await storage.headObject({ bucket: 'private', key: clean.storageKey }))?.sizeBytes,
    ).toBe(bytes.length);
    const thumbHead = await storage.headObject({
      bucket: 'derivatives',
      key: withVariants.derivatives!['thumb']!,
    });
    expect(thumbHead?.contentType).toBe('image/webp');

    const download = await issueDownload(ownerA(), intent.fileId, {}, { ipHash: 'abc' });
    expect(download.contentDisposition).toBe('attachment');
    expect(download.contentType).toBe('image/png');
    const verified = verifyDevStorageUrl(download.url, SIGNING_SECRET);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.params.bucket).toBe('private');
      expect(verified.params.key).toBe(clean.storageKey);
    }
    const thumb = await issueDownload(ownerA(), intent.fileId, { variant: 'thumb' });
    expect(thumb.contentDisposition).toBe('inline');
    expect(thumb.contentType).toBe('image/webp');
    const log = await dbs.owner
      .select()
      .from(schema.fileDownloadLog)
      .where(eq(schema.fileDownloadLog.fileId, intent.fileId));
    expect(log.map((l) => l.purpose).sort()).toEqual(['original', 'variant:thumb']);
    expect(log[0]!.userId).toBe(ids.ownerA);

    const dto = await getFile(ownerA(), intent.fileId);
    expect(dto.variants.sort()).toEqual(['thumb', 'web']);
    expect(dto).not.toHaveProperty('storageKey');
  });

  it('enforces signed URL expiry (default 5 minutes, 15 max) and refuses quarantine downloads', async () => {
    const bytes = Buffer.from('%PDF-1.4\n%test\n');
    const intent = await upload(ownerA(), bytes, {
      fileName: 'letter.pdf',
      declaredMime: 'application/pdf',
    });
    await finalizeUpload(ownerA(), intent.fileId, {});
    await scanFileObject(deps, intent.fileId);
    const issued = await issueDownload(ownerA(), intent.fileId, {});
    const expiresAt = new Date(issued.expiresAt);
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    expect(
      verifyDevStorageUrl(issued.url, SIGNING_SECRET, new Date(expiresAt.getTime() - 1000)).ok,
    ).toBe(true);
    const late = verifyDevStorageUrl(
      issued.url,
      SIGNING_SECRET,
      new Date(expiresAt.getTime() + 1000),
    );
    expect(late).toEqual({ ok: false, reason: 'expired' });
    // A tampered signature is refused even within the window.
    expect(verifyDevStorageUrl(`${issued.url}x`, SIGNING_SECRET).ok).toBe(false);
    const longer = await issueDownload(ownerA(), intent.fileId, { expiresIn: 900 });
    expect(new Date(longer.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    // The adapter never signs quarantine downloads, whatever the caller asks.
    await expect(
      storage.createSignedDownloadUrl({
        bucket: 'quarantine',
        key: (await fileRow(dbs.owner, intent.fileId)).storageKey,
        fileName: 'x',
        contentType: 'application/pdf',
        contentDisposition: 'inline',
      }),
    ).rejects.toMatchObject({ code: 'quarantined' });
  });

  it('marks EICAR uploads infected, keeps them quarantined and refuses downloads', async () => {
    const bytes = Buffer.from(`${EICAR_TEST_STRING}\n`);
    const intent = await upload(ownerA(), bytes, {
      fileName: 'notes.csv',
      declaredMime: 'text/csv',
    });
    const finalized = await finalizeUpload(ownerA(), intent.fileId, {});
    expect(finalized.outcome).toBe('scanning');
    const scan = await scanFileObject(deps, intent.fileId);
    expect(scan.status).toBe('infected');
    const row = await fileRow(dbs.owner, intent.fileId);
    expect(row.status).toBe('infected');
    expect(row.bucket).toBe('quarantine');
    expect(await storage.headObject({ bucket: 'quarantine', key: row.storageKey })).not.toBeNull();
    expect(await storage.headObject({ bucket: 'private', key: row.storageKey })).toBeNull();
    await expect(issueDownload(ownerA(), intent.fileId, {})).rejects.toSatisfy(
      (e) => errorCode(e) === 'file_rejected',
    );
    await expect(issueDownload(superAdmin(), intent.fileId, {})).rejects.toSatisfy(
      (e) => errorCode(e) === 'file_rejected',
    );
    expect((await getFile(ownerA(), intent.fileId)).statusReason).toContain('malware');
    // Re-running the scan does not resurrect the file.
    expect((await scanFileObject(deps, intent.fileId)).status).toBe('skipped');
  });

  it('leaves the object quarantined when the scanner fails, retries three times, then stops', async () => {
    const bytes = Buffer.from('%PDF-1.4\n%plain\n');
    const intent = await upload(ownerA(), bytes, {
      fileName: 'report.scan-error.pdf',
      declaredMime: 'application/pdf',
    });
    await finalizeUpload(ownerA(), intent.fileId, {});
    const first = await scanFileObject(deps, intent.fileId);
    expect(first).toMatchObject({ status: 'scan_failed', attempts: 1, exhausted: false });
    let row = await fileRow(dbs.owner, intent.fileId);
    expect(row.status).toBe('scan_failed');
    expect(row.bucket).toBe('quarantine');
    await expect(issueDownload(ownerA(), intent.fileId, {})).rejects.toSatisfy(
      (e) => errorCode(e) === 'file_quarantined',
    );
    const retries = await dbs.owner
      .select()
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.type, 'files.scan'),
          eq(schema.jobs.dedupeKey, `files.scan:${intent.fileId}:2`),
        ),
      );
    expect(retries).toHaveLength(1);
    expect(retries[0]!.runAt.getTime()).toBeGreaterThan(Date.now());

    expect((await scanFileObject(deps, intent.fileId)).status).toBe('scan_failed');
    const third = await scanFileObject(deps, intent.fileId);
    expect(third).toMatchObject({ status: 'scan_failed', attempts: 3, exhausted: true });
    row = await fileRow(dbs.owner, intent.fileId);
    expect(row.status).toBe('scan_failed');
    expect(row.bucket).toBe('quarantine');
    expect((row.scanResult as { reason: string }).reason).toContain('remains quarantined');
    expect((await scanFileObject(deps, intent.fileId)).status).toBe('skipped');
    await expect(issueDownload(superAdmin(), intent.fileId, {})).rejects.toSatisfy(
      (e) => errorCode(e) === 'file_quarantined',
    );
  });

  it('rejects markup disguised as images, blocked types up front, and size/checksum mismatches', async () => {
    const html = Buffer.from('<!DOCTYPE html><html><body><script>alert(1)</script></body></html>');
    const asPng = await upload(ownerA(), html, {
      fileName: 'photo.png',
      declaredMime: 'image/png',
    });
    const rejectedHtml = await finalizeUpload(ownerA(), asPng.fileId, {});
    expect(rejectedHtml.outcome).toBe('rejected');
    expect(rejectedHtml.file.status).toBe('rejected');
    expect(rejectedHtml.file.statusReason).toContain('html');
    await expect(issueDownload(ownerA(), asPng.fileId, {})).rejects.toSatisfy(
      (e) => errorCode(e) === 'file_rejected',
    );
    // Rejected files never enter the scanner and are never promoted.
    expect((await scanFileObject(deps, asPng.fileId)).status).toBe('skipped');
    expect((await fileRow(dbs.owner, asPng.fileId)).bucket).toBe('quarantine');

    const svg = Buffer.from(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
    );
    const asJpeg = await upload(ownerA(), svg, {
      fileName: 'logo.jpg',
      declaredMime: 'image/jpeg',
    });
    expect((await finalizeUpload(ownerA(), asJpeg.fileId, {})).outcome).toBe('rejected');

    // A JPEG-magic file declared as PDF is a type mismatch.
    const jpegish = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
    const asPdf = await upload(ownerA(), jpegish, {
      fileName: 'scan.pdf',
      declaredMime: 'application/pdf',
    });
    const mismatch = await finalizeUpload(ownerA(), asPdf.fileId, {});
    expect(mismatch.outcome).toBe('rejected');
    expect(mismatch.file.statusReason).toContain('declared application/pdf');

    await expect(
      createUploadIntent(ownerA(), {
        purpose: 'org_document',
        fileName: 'logo.svg',
        declaredMime: 'image/svg+xml',
        sizeBytes: 10,
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'file_rejected');
    await expect(
      createUploadIntent(ownerA(), {
        purpose: 'org_document',
        fileName: 'page.html',
        declaredMime: 'text/html',
        sizeBytes: 10,
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'file_rejected');
    await expect(
      createUploadIntent(ownerA(), {
        purpose: 'org_document',
        fileName: 'run.png',
        declaredMime: 'text/javascript',
        sizeBytes: 10,
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'file_rejected');
    await expect(
      createUploadIntent(ownerA(), {
        purpose: 'bank_receipt',
        fileName: 'clip.mp4',
        declaredMime: 'video/mp4',
        sizeBytes: 10,
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'file_rejected');
    await expect(
      createUploadIntent(ownerA(), {
        purpose: 'identity',
        fileName: 'id.pdf',
        declaredMime: 'application/pdf',
        sizeBytes: 30 * 1024 * 1024,
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'file_rejected');

    // Declared size is bound to the signed URL; a different declared checksum is rejected at finalisation.
    const pdf = Buffer.from('%PDF-1.4\n%x\n');
    const wrongHash = await upload(ownerA(), pdf, {
      fileName: 'a.pdf',
      declaredMime: 'application/pdf',
      sha256: 'a'.repeat(64),
    });
    const hashOutcome = await finalizeUpload(ownerA(), wrongHash.fileId, {});
    expect(hashOutcome.outcome).toBe('rejected');
    expect(hashOutcome.file.statusReason).toContain('SHA-256');
    const sizeIntent = await createUploadIntent(ownerA(), {
      purpose: 'org_document',
      fileName: 'b.pdf',
      declaredMime: 'application/pdf',
      sizeBytes: 100,
    });
    if (sizeIntent.upload.kind !== 'single') throw new Error('unreachable');
    const v = storage.verifySignedRequest(sizeIntent.upload.url);
    if (!v.ok) throw new Error(v.reason);
    await expect(storage.writeUploadedObject(v.params, pdf)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(finalizeUpload(ownerA(), sizeIntent.fileId, {})).rejects.toSatisfy(
      (e) => errorCode(e) === 'conflict',
    );
    // Only the uploader may finalise.
    await expect(finalizeUpload(memberA(), sizeIntent.fileId, {})).rejects.toSatisfy((e) =>
      ['forbidden', 'not_found'].includes(errorCode(e) ?? ''),
    );
  });

  it('plans large uploads as multipart and completes them with part etags', async () => {
    const intent = await createUploadIntent(ownerA(), {
      purpose: 'evidence',
      fileName: 'walkthrough.mp4',
      declaredMime: 'video/mp4',
      sizeBytes: 12,
      multipart: true,
      entityType: 'project',
      entityId: ids.projectA,
    });
    expect(intent.upload.kind).toBe('multipart');
    if (intent.upload.kind !== 'multipart') throw new Error('unreachable');
    expect(intent.upload.parts).toHaveLength(1);
    const v = storage.verifySignedRequest(intent.upload.parts[0]!.url);
    if (!v.ok) throw new Error(v.reason);
    const { etag } = await storage.writeUploadedPart(
      v.params,
      Buffer.from('000000ftyp'.padEnd(12, 'x')),
    );
    await expect(finalizeUpload(ownerA(), intent.fileId, {})).rejects.toSatisfy(
      (e) => errorCode(e) === 'validation_failed',
    );
    await expect(
      finalizeUpload(ownerA(), intent.fileId, { parts: [{ partNumber: 1, etag: '"wrong"' }] }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'validation_failed');
    const finalized = await finalizeUpload(ownerA(), intent.fileId, {
      parts: [{ partNumber: 1, etag }],
    });
    expect(finalized.outcome).toBe('scanning');
    const scan = await scanFileObject(deps, intent.fileId);
    expect(scan).toMatchObject({ status: 'clean', derivativesQueued: false });
    const row = await fileRow(dbs.owner, intent.fileId);
    expect(row.derivatives).toEqual({ video: 'original' });
    expect((await deriveFileObject(deps, intent.fileId)).status).toBe('skipped');
  });
});

describe('access control', () => {
  async function cleanOrgDocument(identity: RequestIdentity = ownerA(), name = 'contract.pdf') {
    const bytes = Buffer.from(`%PDF-1.4\n%${uniqueSuffix()}\n`);
    const intent = await upload(identity, bytes, {
      fileName: name,
      declaredMime: 'application/pdf',
    });
    await finalizeUpload(identity, intent.fileId, {});
    expect((await scanFileObject(deps, intent.fileId)).status).toBe('clean');
    return intent.fileId;
  }

  it('lets organisation members view/download, denies immediately once membership is revoked, and isolates organisations', async () => {
    const fileId = await cleanOrgDocument();
    // Member of org A (role member has org.documents.view).
    expect((await issueDownload(memberA(), fileId, {})).url).toContain('/dev/storage/download');
    // Org B cannot even see the id.
    await expect(getFile(ownerB(), fileId)).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    await expect(issueDownload(ownerB(), fileId, {})).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
    // Revoke the membership in the database; the (stale) session still lists org A.
    await dbs.owner
      .delete(schema.member)
      .where(
        and(eq(schema.member.organizationId, ids.orgA), eq(schema.member.userId, ids.memberA)),
      );
    await expect(issueDownload(memberA(), fileId, {})).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
    await expect(getFile(memberA(), fileId)).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    await dbs.owner.insert(schema.member).values({
      id: `m_${ids.memberA}`,
      organizationId: ids.orgA,
      userId: ids.memberA,
      role: 'member',
    });
    expect((await getFile(memberA(), fileId)).id).toBe(fileId);
  });

  it('honours explicit grants by level and revocation, for users and organisations', async () => {
    const fileId = await cleanOrgDocument();
    // Only the owner or staff can grant.
    await expect(
      createGrant(memberA(), fileId, { userId: ids.ownerB, level: 'view' }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    const view = await createGrant(ownerA(), fileId, { userId: ids.ownerB, level: 'view' });
    expect((await getFile(ownerB(), fileId)).id).toBe(fileId);
    await expect(issueDownload(ownerB(), fileId, {})).rejects.toSatisfy(
      (e) => errorCode(e) === 'forbidden',
    );
    const download = await createGrant(ops(), fileId, {
      userId: ids.ownerB,
      level: 'download',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect((await issueDownload(ownerB(), fileId, {})).url).toBeTruthy();
    await revokeGrant(ownerA(), fileId, download.id);
    await expect(issueDownload(ownerB(), fileId, {})).rejects.toSatisfy(
      (e) => errorCode(e) === 'forbidden',
    );
    await revokeGrant(ownerA(), fileId, view.id);
    await expect(getFile(ownerB(), fileId)).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    // Organisation grants follow the member's current membership.
    const orgGrant = await createGrant(ownerA(), fileId, {
      organizationId: ids.orgB,
      level: 'download',
    });
    expect((await issueDownload(ownerB(), fileId, {})).url).toBeTruthy();
    await dbs.owner.delete(schema.member).where(eq(schema.member.userId, ids.ownerB));
    await expect(issueDownload(ownerB(), fileId, {})).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
    await dbs.owner.insert(schema.member).values({
      id: `m_${ids.ownerB}`,
      organizationId: ids.orgB,
      userId: ids.ownerB,
      role: 'owner',
    });
    await revokeGrant(ownerA(), fileId, orgGrant.id);
    await expect(getFile(ownerB(), fileId)).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    // Expired grants do not count.
    await dbs.owner.insert(schema.fileAccessGrants).values({
      fileId,
      userId: ids.ownerB,
      level: 'download',
      grantedBy: ids.ownerA,
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(getFile(ownerB(), fileId)).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
  });

  it('restricts sensitive purposes to the owner, user grants and staff with files.sensitive.read', async () => {
    const bytes = Buffer.from(`%PDF-1.4\n%id-${uniqueSuffix()}\n`);
    const intent = await upload(ownerA(), bytes, {
      purpose: 'identity',
      fileName: 'passport.pdf',
      declaredMime: 'application/pdf',
    });
    const row = await fileRow(dbs.owner, intent.fileId);
    expect(row.organizationId).toBeNull();
    expect(row.storageKey.startsWith('shared/identity/')).toBe(true);
    await finalizeUpload(ownerA(), intent.fileId, {});
    await scanFileObject(deps, intent.fileId);
    expect((await issueDownload(ownerA(), intent.fileId, {})).url).toBeTruthy();
    // Same organisation is irrelevant for personal documents.
    await expect(getFile(memberA(), intent.fileId)).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
    // operations_manager holds files.read_all but not files.sensitive.read.
    await expect(issueDownload(ops(), intent.fileId, {})).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
    expect((await issueDownload(superAdmin(), intent.fileId, {})).url).toBeTruthy();
    await expect(
      createGrant(ownerA(), intent.fileId, { organizationId: ids.orgB, level: 'view' }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'validation_failed');
    await createGrant(ownerA(), intent.fileId, { userId: ids.ops, level: 'download' });
    expect((await issueDownload(ops(), intent.fileId, {})).url).toBeTruthy();
    const dto = await getFile(ownerA(), intent.fileId);
    expect(dto.sensitive).toBe(true);
    // Never publishable.
    await expect(
      setPublicApproval(superAdmin(), intent.fileId, {
        approved: true,
        altText: 'x',
        rightsConfirmed: true,
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
  });

  it('authorises evidence uploads by assignment and lists entity files by access', async () => {
    const pdf = Buffer.from('%PDF-1.4\n%evidence\n');
    const evidence = {
      purpose: 'evidence' as const,
      fileName: 'footing.pdf',
      declaredMime: 'application/pdf',
      sizeBytes: pdf.length,
      entityType: 'project' as const,
      entityId: ids.projectA,
    };
    // Evidence needs an entity; the customer organisation, assigned staff and assigned partners may upload.
    await expect(
      createUploadIntent(ownerA(), { ...evidence, entityType: undefined, entityId: undefined }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'validation_failed');
    await expect(createUploadIntent(ownerB(), evidence)).rejects.toSatisfy(
      (e) => errorCode(e) === 'forbidden',
    );
    await expect(createUploadIntent(inspector(), evidence)).rejects.toSatisfy(
      (e) => errorCode(e) === 'forbidden',
    );
    await expect(createUploadIntent(partner(), evidence)).rejects.toSatisfy(
      (e) => errorCode(e) === 'forbidden',
    );
    await dbs.owner.insert(schema.assignments).values([
      {
        organizationId: ids.orgA,
        projectId: ids.projectA,
        assigneeUserId: ids.inspector,
        role: 'inspector',
        status: 'active',
        assignedBy: ids.ops,
      },
      {
        organizationId: ids.orgA,
        projectId: ids.projectA,
        assigneeUserId: ids.partner,
        role: 'surveyor',
        status: 'accepted',
        assignedBy: ids.ops,
      },
    ]);
    const byInspector = await upload(inspector(), pdf, evidence);
    const byPartner = await upload(partner(), pdf, evidence);
    const byCustomer = await upload(ownerA(), pdf, evidence);
    for (const id of [byInspector.fileId, byPartner.fileId, byCustomer.fileId]) {
      expect((await fileRow(dbs.owner, id)).organizationId).toBe(ids.orgA);
      await finalizeUpload(
        id === byInspector.fileId ? inspector() : id === byPartner.fileId ? partner() : ownerA(),
        id,
        {},
      );
      await scanFileObject(deps, id);
    }
    const forOwner = await listFilesForEntity(ownerA(), {
      entityType: 'project',
      entityId: ids.projectA,
      limit: 25,
    });
    expect(forOwner.items.map((f) => f.id)).toEqual(
      expect.arrayContaining([byInspector.fileId, byPartner.fileId, byCustomer.fileId]),
    );
    expect(forOwner.items.every((f) => f.organizationId === ids.orgA)).toBe(true);
    // The partner sees only what they uploaded (no organisation membership); org B sees nothing.
    const forPartner = await listFilesForEntity(partner(), {
      entityType: 'project',
      entityId: ids.projectA,
      limit: 25,
    });
    expect(forPartner.items.map((f) => f.id)).toEqual([byPartner.fileId]);
    expect(
      (
        await listFilesForEntity(ownerB(), {
          entityType: 'project',
          entityId: ids.projectA,
          limit: 25,
        })
      ).items,
    ).toEqual([]);
    const paged = await listFilesForEntity(ops(), {
      entityType: 'project',
      entityId: ids.projectA,
      limit: 2,
    });
    expect(paged.items).toHaveLength(2);
    expect(paged.nextCursor).not.toBeNull();
    const rest = await listFilesForEntity(ops(), {
      entityType: 'project',
      entityId: ids.projectA,
      limit: 2,
      cursor: paged.nextCursor!,
    });
    expect(rest.items.length).toBeGreaterThanOrEqual(1);
    expect(rest.items.map((f) => f.id)).not.toContain(paged.items[0]!.id);
    // Staff without file permissions (content editor) do not reach evidence.
    await expect(
      getFile(identityFor(ids.ops, { staffRoles: ['content_editor'] }), byCustomer.fileId),
    ).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
  });

  it('approves only derivatives of clean images for public use, never own uploads or documents', async () => {
    const bytes = await pngBytes(80, 60);
    const intent = await upload(ownerA(), bytes, {
      fileName: 'facade.png',
      declaredMime: 'image/png',
    });
    await finalizeUpload(ownerA(), intent.fileId, {});
    await scanFileObject(deps, intent.fileId);
    await expect(
      setPublicApproval(ownerA(), intent.fileId, {
        approved: true,
        altText: 'Front',
        rightsConfirmed: true,
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    await expect(
      setPublicApproval(ops(), intent.fileId, {
        approved: true,
        altText: 'Front',
        rightsConfirmed: true,
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'conflict');
    await deriveFileObject(deps, intent.fileId);
    await expect(
      setPublicApproval(ops(), intent.fileId, { approved: true, altText: 'Front' }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'validation_failed');
    const approved = await setPublicApproval(ops(), intent.fileId, {
      approved: true,
      altText: 'Front elevation',
      rightsConfirmed: true,
      caption: 'Site A',
    });
    expect(approved.file.isPublicApproved).toBe(true);
    expect(approved.mediaAsset).toMatchObject({
      altText: 'Front elevation',
      approvedForPublic: true,
      rightsConfirmed: true,
    });
    const [asset] = await dbs.owner
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.fileId, intent.fileId));
    expect(asset?.approvedBy).toBe(ids.ops);
    expect(asset?.uploadedBy).toBe(ids.ownerA);
    const revoked = await setPublicApproval(ops(), intent.fileId, { approved: false });
    expect(revoked.file.isPublicApproved).toBe(false);
    expect(revoked.mediaAsset?.approvedForPublic).toBe(false);
    // Staff cannot approve their own upload; documents are never public.
    const own = await upload(superAdmin(), await pngBytes(), {
      purpose: 'content_media',
      fileName: 'banner.png',
      declaredMime: 'image/png',
    });
    expect((await fileRow(dbs.owner, own.fileId)).organizationId).toBeNull();
    await finalizeUpload(superAdmin(), own.fileId, {});
    await scanFileObject(deps, own.fileId);
    await deriveFileObject(deps, own.fileId);
    await expect(
      setPublicApproval(superAdmin(), own.fileId, {
        approved: true,
        altText: 'Banner',
        rightsConfirmed: true,
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    expect(
      (
        await setPublicApproval(ops(), own.fileId, {
          approved: true,
          altText: 'Banner',
          rightsConfirmed: true,
        })
      ).file.isPublicApproved,
    ).toBe(true);
    const pdfId = await cleanOrgDocument();
    await expect(
      setPublicApproval(superAdmin(), pdfId, {
        approved: true,
        altText: 'Doc',
        rightsConfirmed: true,
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'validation_failed');
    // content_media requires content.media.manage.
    await expect(
      createUploadIntent(ownerA(), {
        purpose: 'content_media',
        fileName: 'x.png',
        declaredMime: 'image/png',
        sizeBytes: 10,
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
  });

  it('partner submission files belong to the partner and only partner accounts can create them', async () => {
    const input = {
      purpose: 'partner_submission',
      fileName: 'method-statement.pdf',
      declaredMime: 'application/pdf',
      sizeBytes: 2048,
    } as UploadIntentCreate;
    const intent = await createUploadIntent(partner(), input);
    const [row] = await dbs.owner
      .select()
      .from(schema.fileObjects)
      .where(eq(schema.fileObjects.id, intent.fileId));
    expect(row?.ownerUserId).toBe(ids.partner);
    expect(row?.organizationId).toBeNull();
    for (const who of [ownerA(), ops()]) {
      await expect(createUploadIntent(who, input)).rejects.toSatisfy(
        (e) => errorCode(e) === 'forbidden',
      );
    }
    await expect(
      createUploadIntent(partner(), {
        ...input,
        entityType: 'project',
        entityId: ids.projectA,
      } as UploadIntentCreate),
    ).rejects.toSatisfy((e) => errorCode(e) === 'validation_failed');
  });
});
