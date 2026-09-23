import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { createDb, createPool, type Database } from '../client';
import { TEST_DATABASE_URL, TEST_MIGRATION_DATABASE_URL, applyTestEnv } from './env';

export { TEST_DATABASE_URL, TEST_MIGRATION_DATABASE_URL, applyTestEnv };

export interface TestDatabases {
  /** Runtime role: row-level security applies. */
  app: Database;
  /** Owner role: bypasses row-level security; use for fixtures and assertions. */
  owner: Database;
  close: () => Promise<void>;
}

export function connectTestDatabases(): TestDatabases {
  applyTestEnv();
  const appPool: Pool = createPool(TEST_DATABASE_URL, {
    max: 4,
    applicationName: 'simplexd-test-app',
  });
  const ownerPool: Pool = createPool(TEST_MIGRATION_DATABASE_URL, {
    max: 4,
    applicationName: 'simplexd-test-owner',
  });
  return {
    app: createDb(appPool),
    owner: createDb(ownerPool),
    close: async () => {
      await appPool.end();
      await ownerPool.end();
    },
  };
}

/**
 * Truncates every application table (not PostGIS metadata or the migration
 * ledger). Runs with the owner role.
 */
export async function resetDatabase(owner: Database): Promise<void> {
  const rows = await owner.execute<{ tablename: string }>(sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT IN ('spatial_ref_sys')
  `);
  const names = rows.rows.map((r) => `"public"."${r.tablename}"`);
  if (names.length === 0) return;
  await owner.execute(sql.raw(`TRUNCATE TABLE ${names.join(', ')} RESTART IDENTITY CASCADE`));
}

let counter = 0;
/** Deterministic-enough unique suffix for fixture names within a test run. */
export function uniqueSuffix(): string {
  counter += 1;
  return `${Date.now().toString(36)}${counter.toString(36)}`;
}
