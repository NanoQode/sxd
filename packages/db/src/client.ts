import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type DbExecutor = Database | Transaction;

export interface CreateDbOptions {
  max?: number;
  ssl?: 'disable' | 'require' | 'verify-full';
  applicationName?: string;
}

function sslConfig(mode: CreateDbOptions['ssl']): PoolConfig['ssl'] {
  switch (mode) {
    case 'require':
      // Encrypted transport without certificate verification (managed hosts often
      // present internal CAs). Prefer verify-full where the CA is available.
      return { rejectUnauthorized: false };
    case 'verify-full':
      return { rejectUnauthorized: true };
    default:
      return undefined;
  }
}

export function createPool(connectionString: string, options: CreateDbOptions = {}): Pool {
  return new Pool({
    connectionString,
    max: options.max ?? 10,
    ssl: sslConfig(options.ssl),
    application_name: options.applicationName ?? 'simplexd',
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

export function createDb(pool: Pool): Database {
  return drizzle({ client: pool, schema, casing: 'snake_case' });
}

interface Cached {
  pool: Pool;
  db: Database;
  connectionString: string;
}

const globalCache = globalThis as unknown as { __simplexdDb?: Cached };

function envSsl(): CreateDbOptions['ssl'] {
  const v = process.env.DATABASE_SSL;
  if (v === 'require' || v === 'verify-full') return v;
  return 'disable';
}

/**
 * Process-wide application database handle (runtime role). Cached on
 * globalThis so Next.js hot reloads do not leak pools.
 */
export function getDb(): Database {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  const cached = globalCache.__simplexdDb;
  if (cached && cached.connectionString === connectionString) {
    return cached.db;
  }
  const pool = createPool(connectionString, {
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    ssl: envSsl(),
  });
  const db = createDb(pool);
  globalCache.__simplexdDb = { pool, db, connectionString };
  return db;
}

export async function closeDb(): Promise<void> {
  const cached = globalCache.__simplexdDb;
  if (cached) {
    globalCache.__simplexdDb = undefined;
    await cached.pool.end();
  }
}

/** Owner-role handle for migrations, seeding and bootstrap commands. */
export function createMigrationDb(): { db: Database; pool: Pool } {
  const connectionString = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('MIGRATION_DATABASE_URL (or DATABASE_URL) is not set');
  }
  const pool = createPool(connectionString, {
    max: 2,
    ssl: envSsl(),
    applicationName: 'simplexd-migrate',
  });
  return { db: createDb(pool), pool };
}

export { schema };
