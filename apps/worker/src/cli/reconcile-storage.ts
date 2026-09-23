import { isNull } from 'drizzle-orm';
import { closeDb, getDb, schema, systemContext, withActor } from '@simplexd/db';
import {
  createStorageProvider,
  listBuckets,
  reconcileStorage,
  S3StorageProvider,
  storageConfigFromEnv,
  type FileObjectLike,
  type ReconciliationReport,
} from '@simplexd/integrations/storage';

/**
 * Read-only storage reconciliation (docs/operations/backup-restore.md):
 * compares `file_objects` with the object store's bucket listings and prints
 * what is missing from storage and what sits in storage without a row.
 * Nothing is deleted or modified on either side.
 *
 *   pnpm --filter @simplexd/worker reconcile:storage [--json] [--ignore-prefix p/]...
 *   node dist/cli/reconcile-storage.js   (in the worker image)
 *
 * Uses DATABASE_URL (runtime role, system actor) and the storage variables
 * (STORAGE_PROVIDER, S3_* or DEV_STORAGE_ROOT). Exit code 1 when a required
 * object is missing, so the command doubles as a check after a restore.
 */

function parseArgs(argv: string[]): { json: boolean; ignore: string[] } {
  const out = { json: false, ignore: ['healthchecks/'] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--json') out.json = true;
    else if (arg === '--ignore-prefix' && argv[i + 1]) {
      out.ignore.push(argv[i + 1]!);
      i += 1;
    } else if (arg.startsWith('--ignore-prefix='))
      out.ignore.push(arg.slice('--ignore-prefix='.length));
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: reconcile-storage [--json] [--ignore-prefix <prefix>]...\nRead-only: compares file_objects with the storage buckets.\n',
      );
      process.exit(0);
    }
  }
  return out;
}

function printHuman(report: ReconciliationReport): void {
  const w = (line: string) => process.stdout.write(`${line}\n`);
  w('Storage reconciliation (read-only)');
  for (const b of report.buckets) w(`  ${b.bucket}: ${b.objects} objects, ${b.expected} expected`);
  w(
    `  rows ${report.summary.rows}, required objects ${report.summary.expected}, present ${report.summary.present}, pending uploads ${report.pending}`,
  );
  w(
    `  missing ${report.summary.missing}, orphans ${report.summary.orphans}, lingering ${report.lingering.length}`,
  );
  if (report.missing.length > 0) {
    w('Missing objects (row exists, object does not):');
    for (const m of report.missing)
      w(`  ${m.bucket}/${m.key}  file ${m.fileId} (${m.role}, ${m.status})`);
  }
  if (report.orphans.length > 0) {
    w('Orphan objects (no live row); review before deleting anything:');
    for (const o of report.orphans) w(`  ${o.bucket}/${o.key}`);
  }
  if (report.lingering.length > 0) {
    w('Objects still present for removed or rejected rows (retention purge pending):');
    for (const l of report.lingering) w(`  ${l.bucket}/${l.key}  file ${l.fileId}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = getDb();
  const rows = await withActor(db, systemContext('reconcile-storage'), (tx) =>
    tx
      .select({
        id: schema.fileObjects.id,
        bucket: schema.fileObjects.bucket,
        storageKey: schema.fileObjects.storageKey,
        status: schema.fileObjects.status,
        derivatives: schema.fileObjects.derivatives,
        deletedAt: schema.fileObjects.deletedAt,
      })
      .from(schema.fileObjects)
      .where(isNull(schema.fileObjects.deletedAt)),
  );
  const provider = createStorageProvider(storageConfigFromEnv(process.env));
  const listings = await listBuckets(
    provider,
    provider instanceof S3StorageProvider ? (b) => provider.bucketName(b) : undefined,
  );
  const report = reconcileStorage(rows as FileObjectLike[], listings, {
    ignoredPrefixes: args.ignore,
  });
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printHuman(report);
  process.exitCode = report.missing.length > 0 ? 1 : 0;
}

try {
  await main();
} finally {
  await closeDb();
}
