import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Database } from './client';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the committed SQL migrations folder. */
export const migrationsFolder = path.resolve(here, '../migrations');

/** Applies all pending migrations. Must run with the owner role. */
export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder, migrationsTable: 'schema_migrations' });
}
