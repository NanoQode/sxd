import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createMigrationDb } from '../client';
import * as s from '../schema';
import { loadEnv } from './_env';

loadEnv();

/**
 * Secure first-administrator bootstrap. Creates a one-time setup token bound to
 * an email address and prints the setup link; the person completes account
 * creation (password, MFA enrolment) in the browser. No password is ever
 * passed on the command line or stored here.
 *
 * Usage: pnpm db:bootstrap-admin --email admin@example.com [--hours 24]
 */
const args = process.argv.slice(2);
const emailIdx = args.indexOf('--email');
const email = emailIdx >= 0 ? args[emailIdx + 1] : undefined;
const hoursIdx = args.indexOf('--hours');
const hours = hoursIdx >= 0 ? Number(args[hoursIdx + 1]) : 24;

if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error('Usage: pnpm db:bootstrap-admin --email admin@example.com [--hours 24]');
  process.exit(1);
}

const { db, pool } = createMigrationDb();
try {
  const existingAdmins = await db.execute<{ count: string }>(
    sql`select count(*)::text as count from staff_roles where role = 'super_admin' and revoked_at is null`,
  );
  const adminCount = Number(existingAdmins.rows[0]?.count ?? '0');
  if (adminCount > 0 && !args.includes('--force')) {
    console.error(
      `A super administrator already exists (${adminCount}). Grant further administrators from Admin -> Access, or pass --force to issue another setup link (audited).`,
    );
    process.exit(2);
  }
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + hours * 3600 * 1000);
  await db.insert(s.setupTokens).values({
    purpose: 'first_admin',
    tokenHash,
    email: email.toLowerCase(),
    payload: { roles: ['super_admin'], forced: args.includes('--force') },
    expiresAt,
  });
  await db.insert(s.auditEvents).values({
    actorType: 'system',
    action: 'setup_token.issued',
    entityType: 'setup_token',
    entityId: tokenHash.slice(0, 12),
    after: {
      email: email.toLowerCase(),
      purpose: 'first_admin',
      expiresAt: expiresAt.toISOString(),
    },
    reason: 'bootstrap-admin CLI',
  });
  const base = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  console.log('');
  console.log('First administrator setup link (single use, keep private):');
  console.log(`${base}/setup/${token}`);
  console.log(`Expires: ${expiresAt.toISOString()}`);
  console.log('');
} finally {
  await pool.end();
}
