import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Database } from './client';
import { migrationsFolder, runMigrations } from './migrate';
import { checkRuntimeRole } from './runtime-checks';
import * as s from './schema';
import { withActor } from './tenant';
import { TEST_DATABASE_URL, TEST_MIGRATION_DATABASE_URL, uniqueSuffix } from './testing';

/**
 * Migrations against a clean database and against the previous schema
 * snapshot (brief §21): a temporary database receives migrations 0000–0006,
 * representative rows are inserted, migration 0007 is applied on top, and
 * the rows must survive while the new tables come up with row-level security
 * that the runtime role cannot bypass. A second clean database proves that
 * migrating twice is a no-op. Both databases are dropped afterwards.
 */

const LATEST_TAG = '0007_engagement_items_templates_requirements';
const NEW_TABLES = ['engagement_items', 'report_templates', 'document_requirements'];

interface Journal {
  entries: Array<{ idx: number; tag: string }>;
}

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/** Copies the migrations folder with the journal truncated before `excludeTag`. */
async function snapshotFolder(excludeTag: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sxd-migrations-'));
  await mkdir(path.join(dir, 'meta'));
  const journal = JSON.parse(
    await readFile(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
  ) as Journal & Record<string, unknown>;
  const cutoff = journal.entries.findIndex((e) => e.tag === excludeTag);
  if (cutoff === -1) throw new Error(`journal has no entry ${excludeTag}`);
  const kept = journal.entries.slice(0, cutoff);
  await writeFile(
    path.join(dir, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: kept }, null, 2),
  );
  for (const entry of kept) {
    const file = `${entry.tag}.sql`;
    await writeFile(path.join(dir, file), await readFile(path.join(migrationsFolder, file)));
  }
  return dir;
}

interface Temp {
  name: string;
  owner: Database;
  app: Database;
  close: () => Promise<void>;
}

interface Fingerprint {
  migrations: number;
  tables: string[];
  columns: number;
  policies: number;
  triggers: number;
}

async function schemaFingerprint(db: Database): Promise<Fingerprint> {
  const migrations = await db.execute<{ n: string }>(
    sql`select count(*)::text as n from drizzle.schema_migrations`,
  );
  const tables = await db.execute<{ t: string }>(
    sql`select table_name as t from information_schema.tables where table_schema = 'public' order by 1`,
  );
  const columns = await db.execute<{ n: string }>(
    sql`select count(*)::text as n from information_schema.columns where table_schema = 'public'`,
  );
  const policies = await db.execute<{ n: string }>(
    sql`select count(*)::text as n from pg_policies where schemaname = 'public'`,
  );
  const triggers = await db.execute<{ n: string }>(
    sql`select count(*)::text as n from information_schema.triggers where trigger_schema = 'public'`,
  );
  return {
    migrations: Number(migrations.rows[0]!.n),
    tables: tables.rows.map((r) => r.t),
    columns: Number(columns.rows[0]!.n),
    policies: Number(policies.rows[0]!.n),
    triggers: Number(triggers.rows[0]!.n),
  };
}

describe('migrations', () => {
  const admin = createPool(TEST_MIGRATION_DATABASE_URL, {
    max: 1,
    applicationName: 'sxd-mig-admin',
  });
  const adminDb = createDb(admin);
  const temps: Temp[] = [];
  const folders: string[] = [];
  let canCreate = false;

  async function createTemp(): Promise<Temp> {
    const name = `sxd_mig_${uniqueSuffix()}`.toLowerCase();
    await adminDb.execute(sql.raw(`CREATE DATABASE "${name}"`));
    const ownerPool = createPool(withDatabase(TEST_MIGRATION_DATABASE_URL, name), { max: 2 });
    const appPool = createPool(withDatabase(TEST_DATABASE_URL, name), { max: 2 });
    const temp: Temp = {
      name,
      owner: createDb(ownerPool),
      app: createDb(appPool),
      close: async () => {
        await appPool.end();
        await ownerPool.end();
      },
    };
    temps.push(temp);
    return temp;
  }

  beforeAll(async () => {
    const role = await adminDb.execute<{ ok: boolean }>(
      sql`select (rolsuper or rolcreatedb) as ok from pg_roles where rolname = current_user`,
    );
    canCreate = role.rows[0]?.ok === true;
  });

  afterAll(async () => {
    for (const temp of temps) {
      await temp.close();
      await adminDb.execute(sql.raw(`DROP DATABASE IF EXISTS "${temp.name}" WITH (FORCE)`));
    }
    await admin.end();
    for (const dir of folders) await rm(dir, { recursive: true, force: true });
  });

  it('applies the latest migration on top of the previous snapshot without losing rows, with RLS on the new tables', async (ctx) => {
    if (!canCreate) ctx.skip('owner role cannot CREATE DATABASE');
    const temp = await createTemp();
    const previous = await snapshotFolder(LATEST_TAG);
    folders.push(previous);
    await migrate(temp.owner, { migrationsFolder: previous, migrationsTable: 'schema_migrations' });

    const before = await schemaFingerprint(temp.owner);
    expect(before.migrations).toBe(
      (await readdir(migrationsFolder)).filter((f) => f.endsWith('.sql')).length - 1,
    );
    for (const table of NEW_TABLES) expect(before.tables, table).not.toContain(table);

    // Representative rows under the previous schema.
    const run = uniqueSuffix();
    const userId = `user_${run}`;
    const orgId = `org_${run}`;
    await temp.owner
      .insert(s.user)
      .values({ id: userId, name: 'Ada', email: `${userId}@example.test` });
    await temp.owner.insert(s.organization).values({ id: orgId, name: 'Org', slug: orgId });
    await temp.owner
      .insert(s.member)
      .values({ id: `m_${run}`, organizationId: orgId, userId, role: 'owner' });
    const [service] = await temp.owner
      .insert(s.services)
      .values({
        slug: `svc-${run}`,
        name: 'Due diligence',
        shortDescription: 'test',
        workflowTemplateKey: 'due_diligence',
      })
      .returning({ id: s.services.id });
    const [request] = await temp.owner
      .insert(s.serviceRequests)
      .values({
        reference: `SR-${run}`,
        organizationId: orgId,
        requestedByUserId: userId,
        serviceId: service!.id,
        title: 'Check a parcel',
        status: 'in_progress',
      })
      .returning({ id: s.serviceRequests.id, updatedAt: s.serviceRequests.updatedAt });
    const [report] = await temp.owner
      .insert(s.reports)
      .values({
        organizationId: orgId,
        serviceRequestId: request!.id,
        kind: 'diligence_memo',
        title: 'Findings',
        status: 'in_review',
        createdBy: userId,
      })
      .returning({ id: s.reports.id });
    await temp.owner.insert(s.auditEvents).values({
      actorType: 'user',
      actorUserId: userId,
      action: 'report.submitted',
      entityType: 'report',
      entityId: report!.id,
    });

    // Upgrade: the real folder applies only what is missing (0007).
    await runMigrations(temp.owner);
    const after = await schemaFingerprint(temp.owner);
    expect(after.migrations).toBe(before.migrations + 1);
    for (const table of NEW_TABLES) expect(after.tables, table).toContain(table);
    expect(after.tables).toEqual(expect.arrayContaining(before.tables));

    const [sr] = await temp.owner
      .select()
      .from(s.serviceRequests)
      .where(sql`${s.serviceRequests.id} = ${request!.id}`);
    expect(sr).toMatchObject({
      reference: `SR-${run}`,
      status: 'in_progress',
      organizationId: orgId,
    });
    const [rp] = await temp.owner
      .select()
      .from(s.reports)
      .where(sql`${s.reports.id} = ${report!.id}`);
    expect(rp).toMatchObject({ title: 'Findings', status: 'in_review', currentVersion: 0 });
    const users = await temp.owner.select({ id: s.user.id }).from(s.user);
    expect(users.map((u) => u.id)).toEqual([userId]);
    const audits = await temp.owner.select({ action: s.auditEvents.action }).from(s.auditEvents);
    expect(audits.map((a) => a.action)).toEqual(['report.submitted']);

    // New tables: RLS enabled, policies present, runtime role granted but not able to bypass.
    const rls = await temp.owner.execute<{ table: string; enabled: boolean; policies: string }>(sql`
      select c.relname as "table", c.relrowsecurity as enabled,
        (select count(*)::text from pg_policies p where p.tablename = c.relname) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in (${sql.join(
        NEW_TABLES.map((t) => sql`${t}`),
        sql`, `,
      )})
    `);
    expect(rls.rows).toHaveLength(NEW_TABLES.length);
    for (const row of rls.rows) {
      expect(row.enabled, row.table).toBe(true);
      expect(Number(row.policies), row.table).toBeGreaterThan(0);
    }
    const runtime = await checkRuntimeRole(temp.app);
    expect(runtime).toMatchObject({
      rlsEnforced: true,
      superuser: false,
      bypassRls: false,
      ownsTables: false,
    });

    // The runtime role sees the customer's engagement item only in the customer's context.
    await temp.owner.insert(s.engagementItems).values({
      organizationId: orgId,
      serviceRequestId: request!.id,
      kind: 'document_check',
      title: 'Title deed',
      visibility: 'customer',
    });
    const asAnonymous = await withActor(
      temp.app,
      { userId: null, organizationId: null, staff: false },
      (tx) => tx.select({ id: s.engagementItems.id }).from(s.engagementItems),
    );
    expect(asAnonymous).toEqual([]);
    const asOtherOrg = await withActor(
      temp.app,
      { userId: `user_other_${run}`, organizationId: `org_other_${run}`, staff: false },
      (tx) => tx.select({ id: s.engagementItems.id }).from(s.engagementItems),
    );
    expect(asOtherOrg).toEqual([]);
    const asOwner = await withActor(
      temp.app,
      { userId, organizationId: orgId, staff: false },
      (tx) => tx.select({ title: s.engagementItems.title }).from(s.engagementItems),
    );
    expect(asOwner).toEqual([{ title: 'Title deed' }]);
    const asStaff = await withActor(
      temp.app,
      { userId: 'staff', organizationId: null, staff: true },
      (tx) => tx.select({ title: s.engagementItems.title }).from(s.engagementItems),
    );
    expect(asStaff).toEqual([{ title: 'Title deed' }]);
  }, 180_000);

  it('migrates a clean database and applying every migration again is a no-op', async (ctx) => {
    if (!canCreate) ctx.skip('owner role cannot CREATE DATABASE');
    const temp = await createTemp();
    await runMigrations(temp.owner);
    const first = await schemaFingerprint(temp.owner);
    expect(first.migrations).toBe(
      (await readdir(migrationsFolder)).filter((f) => f.endsWith('.sql')).length,
    );
    expect(first.tables).toEqual(expect.arrayContaining(NEW_TABLES));
    expect(first.policies).toBeGreaterThan(0);

    await runMigrations(temp.owner);
    const second = await schemaFingerprint(temp.owner);
    expect(second).toEqual(first);
    expect((await checkRuntimeRole(temp.app)).rlsEnforced).toBe(true);
  }, 180_000);
});
