import fs from 'node:fs';
import path from 'node:path';
import { createMigrationDb } from '../client';
import { importMarketSeed, seedConfigurationDefaults, seedReferenceData } from '../seed';
import { seedContentPages } from '../seed/content';
import { loadEnv } from './_env';

loadEnv();

/**
 * Seeds reference data and imports the 50-market research seed. Safe to
 * re-run. Demo accounts are created separately (`pnpm --filter @simplexd/web seed:demo`)
 * and refused outside development/test.
 */
const seedPath =
  process.env.MARKET_SEED_FILE ??
  path.resolve(process.cwd(), '../../data/seed/nigeria-50-markets.seed.json');

const { db, pool } = createMigrationDb();
try {
  await seedReferenceData(db);
  console.log('Reference data seeded.');
  const config = await seedConfigurationDefaults(db);
  console.log(
    `Configuration defaults seeded (${config.reportTemplatesInserted} report templates, ${config.documentRequirementsInserted} document requirements inserted; existing ones untouched).`,
  );
  const pages = await seedContentPages(db);
  console.log(`Content pages seeded (${pages} inserted; existing pages untouched).`);
  if (fs.existsSync(seedPath)) {
    const raw = JSON.parse(fs.readFileSync(seedPath, 'utf8')) as unknown;
    const summary = await importMarketSeed(db, raw);
    console.log(JSON.stringify(summary, null, 2));
    if (summary.issues.length > 0) {
      console.error('Seed validation failed; nothing imported.');
      process.exitCode = 1;
    }
  } else {
    console.warn(`Market seed not found at ${seedPath}; skipping market import.`);
  }
} finally {
  await pool.end();
}
