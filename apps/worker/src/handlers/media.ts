import type { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import sharp from 'sharp';
import {
  enqueueJob,
  schema,
  systemContext,
  withActor,
  type Database,
  type Transaction,
} from '@simplexd/db';
import {
  createMalwareScanner,
  scannerConfigFromEnv,
  type MalwareScanner,
  type ScanResult,
} from '@simplexd/integrations/scanner';
import {
  StorageError,
  createStorageProvider,
  deriveVariantKey,
  storageConfigFromEnv,
  type ObjectLocation,
  type StorageProvider,
} from '@simplexd/integrations/storage';
import type { JobContext, JobRunner } from '../runner';

/**
 * File pipeline jobs.
 *
 * - `files.scan` (also reached as `media.scan_and_process` from the
 *   `file.uploaded` outbox event): runs the malware scanner over the
 *   quarantined object. `clean` promotes it to the private bucket and queues
 *   derivatives for images; `infected` marks the row and leaves the object in
 *   quarantine; a scanner `error` marks `scan_failed`, leaves the object in
 *   quarantine and retries up to MAX_SCAN_ATTEMPTS times, after which the file
 *   stays quarantined with a recorded reason. A failed scanner never yields a
 *   downloadable file.
 * - `files.derive`: web-size and thumbnail WebP variants (EXIF stripped) in the
 *   derivatives bucket. Originals are never modified. Video gets no derivative
 *   yet (`derivatives.video = 'original'`).
 */

export const FILE_SCAN_JOB = 'files.scan';
export const FILE_DERIVE_JOB = 'files.derive';
/** Job type the outbox relay maps `file.uploaded` to. */
export const MEDIA_SCAN_JOB = 'media.scan_and_process';
export const MAX_SCAN_ATTEMPTS = 3;
export const WEB_VARIANT_MAX_PX = 1600;
export const THUMB_VARIANT_MAX_PX = 320;

export interface MediaDeps {
  db: Database;
  storage: StorageProvider;
  scanner: MalwareScanner;
  log: Logger;
}

let envDeps: Omit<MediaDeps, 'db' | 'log'> | null = null;

/** Builds the storage and scanner adapters from the documented environment variables. */
export function mediaAdaptersFromEnv(): Omit<MediaDeps, 'db' | 'log'> {
  if (!envDeps) {
    envDeps = {
      storage: createStorageProvider(storageConfigFromEnv(process.env)),
      scanner: createMalwareScanner(scannerConfigFromEnv(process.env)),
    };
  }
  return envDeps;
}

type FileRow = typeof schema.fileObjects.$inferSelect;

interface ScanRecord {
  verdict?: string;
  signature?: string | null;
  engine?: string;
  durationMs?: number;
  error?: string;
  reason?: string;
  attempts?: number;
  exhausted?: boolean;
  inspection?: unknown;
}

function scanRecordOf(file: FileRow): ScanRecord {
  return file.scanResult && typeof file.scanResult === 'object'
    ? (file.scanResult as ScanRecord)
    : {};
}

export type ScanOutcome =
  | { status: 'clean'; derivativesQueued: boolean }
  | { status: 'infected'; signature: string | null }
  | { status: 'scan_failed'; attempts: number; exhausted: boolean; reason: string }
  | { status: 'skipped'; reason: string };

async function loadFile(db: Database, fileId: string): Promise<FileRow | null> {
  return withActor(db, systemContext(), async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.fileObjects)
      .where(eq(schema.fileObjects.id, fileId));
    return row ?? null;
  });
}

async function audit(
  tx: Transaction,
  file: FileRow,
  action: string,
  after: Record<string, unknown>,
  correlationId: string | null,
): Promise<void> {
  await tx.insert(schema.auditEvents).values({
    actorType: 'job',
    actorUserId: null,
    organizationId: file.organizationId,
    action,
    entityType: 'file',
    entityId: file.id,
    after,
    correlationId,
  });
}

/** Scans one quarantined file. Safe to re-run: files that are not awaiting a scan are skipped. */
export async function scanFileObject(
  deps: MediaDeps,
  fileId: string,
  options: { correlationId?: string | null } = {},
): Promise<ScanOutcome> {
  const { db, storage, scanner, log } = deps;
  const correlationId = options.correlationId ?? null;
  const file = await loadFile(db, fileId);
  if (!file || file.deletedAt) return { status: 'skipped', reason: 'file not found' };
  if (file.status !== 'scanning' && file.status !== 'scan_failed') {
    return { status: 'skipped', reason: `file is ${file.status}` };
  }
  if (file.bucket !== 'quarantine')
    return { status: 'skipped', reason: `file is in the ${file.bucket} bucket` };
  const previous = scanRecordOf(file);
  if (file.status === 'scan_failed' && previous.exhausted) {
    return { status: 'skipped', reason: 'scan retry budget exhausted; file remains quarantined' };
  }
  const attempts = (previous.attempts ?? 0) + 1;
  const location: ObjectLocation = { bucket: 'quarantine', key: file.storageKey };

  let result: ScanResult;
  try {
    const stream = await storage.getObjectStream(location);
    result = await scanner.scan(stream, {
      fileName: file.originalName,
      sizeBytes: file.sizeBytes ?? 0,
    });
  } catch (err) {
    const message = err instanceof StorageError ? `storage: ${err.code}` : 'scanner threw';
    result = {
      verdict: 'error',
      signature: null,
      engine: scanner.id,
      durationMs: 0,
      error: message,
    };
  }

  const scannedAt = new Date();
  if (result.verdict === 'clean') {
    // Promote quarantine → private before the row changes, so a crash between the
    // two leaves the row in `scanning` (re-scannable) rather than pointing at nothing.
    await storage.copyObject(location, { bucket: 'private', key: file.storageKey });
    await storage.deleteObject(location);
    const mime = file.detectedMime ?? file.declaredMime;
    const isImage = mime.startsWith('image/');
    const isVideo = mime.startsWith('video/');
    const derivativesQueued = await withActor(
      db,
      systemContext(correlationId ?? undefined),
      async (tx) => {
        await tx
          .update(schema.fileObjects)
          .set({
            bucket: 'private',
            status: 'clean',
            scannedAt,
            scanResult: {
              ...previous,
              verdict: 'clean',
              signature: null,
              engine: result.engine,
              durationMs: result.durationMs,
              attempts,
              exhausted: false,
            },
            derivatives: isVideo
              ? { ...(file.derivatives ?? {}), video: 'original' }
              : (file.derivatives ?? null),
            retentionUntil: null,
          })
          .where(eq(schema.fileObjects.id, fileId));
        await audit(
          tx,
          file,
          'file.scan_clean',
          { engine: result.engine, attempts },
          correlationId,
        );
        if (!isImage) return false;
        await enqueueJob(tx, {
          type: FILE_DERIVE_JOB,
          queue: 'media',
          payload: { fileId },
          organizationId: file.organizationId,
          actorUserId: file.ownerUserId,
          dedupeKey: `${FILE_DERIVE_JOB}:${fileId}`,
          correlationId,
        });
        return true;
      },
    );
    log.info(
      { fileId, engine: result.engine, ms: result.durationMs, derivativesQueued },
      'file scan clean',
    );
    return { status: 'clean', derivativesQueued };
  }

  if (result.verdict === 'infected') {
    await withActor(db, systemContext(correlationId ?? undefined), async (tx) => {
      await tx
        .update(schema.fileObjects)
        .set({
          status: 'infected',
          scannedAt,
          scanResult: {
            ...previous,
            verdict: 'infected',
            signature: result.signature,
            engine: result.engine,
            durationMs: result.durationMs,
            attempts,
            exhausted: false,
            reason: `malware detected (${result.signature ?? 'unknown signature'}); the object stays in quarantine`,
          },
          retentionUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        })
        .where(eq(schema.fileObjects.id, fileId));
      await audit(
        tx,
        file,
        'file.scan_infected',
        { engine: result.engine, signature: result.signature },
        correlationId,
      );
    });
    log.warn(
      { fileId, signature: result.signature, engine: result.engine },
      'file scan infected; left in quarantine',
    );
    return { status: 'infected', signature: result.signature };
  }

  // Scanner error: the object stays quarantined; bounded retries.
  const exhausted = attempts >= MAX_SCAN_ATTEMPTS;
  const reason = exhausted
    ? `the malware scanner failed ${attempts} times (${result.error ?? 'unknown error'}); the file remains quarantined until an administrator re-queues the scan`
    : `the malware scanner failed (${result.error ?? 'unknown error'}); retry ${attempts} of ${MAX_SCAN_ATTEMPTS} scheduled`;
  await withActor(db, systemContext(correlationId ?? undefined), async (tx) => {
    await tx
      .update(schema.fileObjects)
      .set({
        status: 'scan_failed',
        scannedAt,
        scanResult: {
          ...previous,
          verdict: 'error',
          signature: null,
          engine: result.engine,
          durationMs: result.durationMs,
          error: result.error ?? 'unknown error',
          attempts,
          exhausted,
          reason,
        },
        retentionUntil: exhausted ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : null,
      })
      .where(eq(schema.fileObjects.id, fileId));
    await audit(
      tx,
      file,
      'file.scan_failed',
      { engine: result.engine, attempts, exhausted, error: result.error ?? null },
      correlationId,
    );
    if (!exhausted) {
      await enqueueJob(tx, {
        type: FILE_SCAN_JOB,
        queue: 'media',
        payload: { fileId, attempt: attempts + 1 },
        organizationId: file.organizationId,
        actorUserId: file.ownerUserId,
        runAt: new Date(Date.now() + attempts * 60_000),
        dedupeKey: `${FILE_SCAN_JOB}:${fileId}:${attempts + 1}`,
        correlationId,
      });
    }
  });
  log.warn(
    { fileId, attempts, exhausted, error: result.error },
    'file scan failed; object stays quarantined',
  );
  return { status: 'scan_failed', attempts, exhausted, reason };
}

export type DeriveOutcome =
  | { status: 'done'; variants: Array<'web' | 'thumb'> }
  | { status: 'failed'; reason: string }
  | { status: 'skipped'; reason: string };

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

/** Generates web and thumbnail variants for a clean image; the original is left untouched. */
export async function deriveFileObject(deps: MediaDeps, fileId: string): Promise<DeriveOutcome> {
  const { db, storage, log } = deps;
  const file = await loadFile(db, fileId);
  if (!file || file.deletedAt) return { status: 'skipped', reason: 'file not found' };
  if (file.status !== 'clean' || file.bucket !== 'private')
    return { status: 'skipped', reason: `file is ${file.status} in ${file.bucket}` };
  const mime = file.detectedMime ?? file.declaredMime;
  if (!mime.startsWith('image/'))
    return { status: 'skipped', reason: `${mime} has no derivatives` };
  const existing = file.derivatives ?? {};
  if (typeof existing['web'] === 'string' && typeof existing['thumb'] === 'string') {
    return { status: 'done', variants: ['web', 'thumb'] };
  }
  let derivatives: Record<string, string>;
  try {
    const original = await collect(
      await storage.getObjectStream({ bucket: 'private', key: file.storageKey }),
    );
    // sharp drops EXIF/GPS/ICC unless withMetadata() is called; rotate() applies the orientation first.
    const base = sharp(original, { failOn: 'error', limitInputPixels: 80_000_000 }).rotate();
    const webKey = deriveVariantKey(file.storageKey, 'web', '.webp');
    const thumbKey = deriveVariantKey(file.storageKey, 'thumb', '.webp');
    const web = await base
      .clone()
      .resize({
        width: WEB_VARIANT_MAX_PX,
        height: WEB_VARIANT_MAX_PX,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 82 })
      .toBuffer();
    const thumb = await base
      .clone()
      .resize({
        width: THUMB_VARIANT_MAX_PX,
        height: THUMB_VARIANT_MAX_PX,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 75 })
      .toBuffer();
    await storage.putObject({ bucket: 'derivatives', key: webKey }, web, 'image/webp');
    await storage.putObject({ bucket: 'derivatives', key: thumbKey }, thumb, 'image/webp');
    derivatives = { ...existing, web: webKey, thumb: thumbKey };
  } catch (err) {
    const reason =
      err instanceof Error ? err.message.slice(0, 300) : 'derivative generation failed';
    await withActor(db, systemContext(), (tx) =>
      tx
        .update(schema.fileObjects)
        .set({ derivatives: { ...existing, error: reason } })
        .where(eq(schema.fileObjects.id, fileId)),
    );
    log.warn({ fileId, reason }, 'derivative generation failed; original retained');
    return { status: 'failed', reason };
  }
  await withActor(db, systemContext(), (tx) =>
    tx.update(schema.fileObjects).set({ derivatives }).where(eq(schema.fileObjects.id, fileId)),
  );
  log.info({ fileId }, 'derivatives generated');
  return { status: 'done', variants: ['web', 'thumb'] };
}

function fileIdFromPayload(payload: unknown): string | null {
  const p = (payload ?? {}) as { fileId?: unknown; event?: { aggregateId?: unknown } };
  if (typeof p.fileId === 'string') return p.fileId;
  if (typeof p.event?.aggregateId === 'string') return p.event.aggregateId;
  return null;
}

export function registerMediaHandlers(runner: JobRunner): void {
  const scan = async ({ db, job, log }: JobContext) => {
    const fileId = fileIdFromPayload(job.payload);
    if (!fileId) {
      log.warn('scan job without fileId');
      return;
    }
    const outcome = await scanFileObject({ db, log, ...mediaAdaptersFromEnv() }, fileId, {
      correlationId: job.correlationId,
    });
    log.info({ fileId, outcome: outcome.status }, 'scan job finished');
  };
  runner.register(FILE_SCAN_JOB, scan);
  runner.register(MEDIA_SCAN_JOB, scan);
  runner.register(FILE_DERIVE_JOB, async ({ db, job, log }) => {
    const fileId = fileIdFromPayload(job.payload);
    if (!fileId) {
      log.warn('derive job without fileId');
      return;
    }
    const outcome = await deriveFileObject({ db, log, ...mediaAdaptersFromEnv() }, fileId);
    log.info({ fileId, outcome: outcome.status }, 'derive job finished');
  });
}
