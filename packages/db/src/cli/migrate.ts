import { createMigrationDb } from '../client';
import { runMigrations } from '../migrate';
import { loadEnv } from './_env';

loadEnv();

const { db, pool } = createMigrationDb();
try {
  await runMigrations(db);
  console.log('Migrations applied.');
} finally {
  await pool.end();
}
