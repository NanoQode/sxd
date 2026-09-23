import fs from 'node:fs';
import path from 'node:path';
import { createMigrationDb } from '../client';
import { importMarketSeed } from '../seed';
import { loadEnv } from './_env';

loadEnv();

/**
 * Usage: pnpm db:import-markets [--dry-run] [path/to/seed.json]
 */
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const fileArg = args.find((a) => !a.startsWith('--'));
const seedPath = fileArg
  ? path.resolve(process.cwd(), fileArg)
  : (process.env.MARKET_SEED_FILE ??
    path.resolve(process.cwd(), '../../data/seed/nigeria-50-markets.seed.json'));

if (!fs.existsSync(seedPath)) {
  console.error(`Seed file not found: ${seedPath}`);
  process.exit(1);
}

const { db, pool } = createMigrationDb();
try {
  const raw = JSON.parse(fs.readFileSync(seedPath, 'utf8')) as unknown;
  const summary = await importMarketSeed(db, raw, { dryRun });
  console.log(JSON.stringify(summary, null, 2));
  if (summary.issues.length > 0) process.exitCode = 1;
} finally {
  await pool.end();
}
