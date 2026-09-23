import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Database } from './client';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the committed SQL migrations folder. From the source tree
 * it sits beside `src/`; in the worker container the CLI bundle lives in
 * `dist/cli/` and the folder is copied to the image root, so the first
 * candidate that holds a journal wins. `MIGRATIONS_DIR` overrides the search.
 */
function resolveMigrationsFolder(): string {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    path.resolve(here, '../migrations'),
    path.resolve(here, '../../migrations'),
    path.resolve(process.cwd(), 'migrations'),
    path.resolve(process.cwd(), 'packages/db/migrations'),
  ].filter((p): p is string => Boolean(p));
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'meta', '_journal.json'))) return candidate;
  }
  throw new Error(
    `migrations folder not found (looked in ${candidates.join(', ')}); set MIGRATIONS_DIR`,
  );
}

export const migrationsFolder = resolveMigrationsFolder();

/** Applies all pending migrations. Must run with the owner role. */
export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder, migrationsTable: 'schema_migrations' });
}
