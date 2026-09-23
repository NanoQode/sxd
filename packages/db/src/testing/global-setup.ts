import { createDb, createPool } from '../client';
import { runMigrations } from '../migrate';
import { TEST_MIGRATION_DATABASE_URL, applyTestEnv } from './env';

/**
 * Vitest global setup: migrates the disposable test database with the owner
 * role before any integration suite runs. Test files then reset the tables
 * they touch through `resetDatabase()`.
 */
export default async function globalSetup(): Promise<void> {
  applyTestEnv();
  const pool = createPool(TEST_MIGRATION_DATABASE_URL, {
    max: 2,
    applicationName: 'simplexd-test-setup',
  });
  try {
    const db = createDb(pool);
    await runMigrations(db);
  } finally {
    await pool.end();
  }
}
