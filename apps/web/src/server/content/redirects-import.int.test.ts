import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@simplexd/db';
import { connectTestDatabases, uniqueSuffix, type TestDatabases } from '@simplexd/db/testing';
import { staffIdentity } from '@/testing/identity';
import { GET as snapshotRoute } from '@/app/api/v1/redirects/snapshot/route';
import { POST as hitRoute } from '@/app/api/v1/redirects/hits/route';
import {
  createRedirect,
  getRedirectSnapshot,
  importRedirects,
  recordRedirectHit,
} from './redirects';

/**
 * Redirect creation guards (reserved and live paths), the bulk CSV import
 * with dry run, and the snapshot/hit endpoints the proxy relies on.
 */

let dbs: TestDatabases;
const sfx = uniqueSuffix();
const userId = `redirect_admin_${sfx}`;
const admin = () =>
  staffIdentity({ userId, email: `${userId}@example.test`, roles: ['content_editor'] });

beforeAll(async () => {
  dbs = connectTestDatabases();
  await dbs.owner.insert(schema.user).values({ id: userId, name: 'Admin', email: `${userId}@example.test` });
  await dbs.owner.insert(schema.staffRoles).values({ userId, role: 'content_editor' });
});

afterAll(async () => {
  await dbs.close();
});

describe('creation guards', () => {
  it('refuses reserved prefixes and paths that are live pages', async () => {
    for (const fromPath of ['/api/v1/markets', '/admin/content', '/portal', '/media/x', '/_next/static']) {
      await expect(
        createRedirect(admin(), { fromPath, toPath: '/about', statusCode: 301, active: true }, { correlationId: 'c' }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    }
    await expect(
      createRedirect(admin(), { fromPath: '/about', toPath: '/contact', statusCode: 301, active: true }, { correlationId: 'c' }),
    ).rejects.toMatchObject({ code: 'validation_failed', message: expect.stringContaining('existing page') });
    await expect(
      createRedirect(admin(), { fromPath: '/policies/privacy', toPath: '/', statusCode: 301, active: true }, { correlationId: 'c' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('csv import', () => {
  it('previews every row without writing, then creates only the valid rows', async () => {
    const existingFrom = `/existing-${sfx}`;
    await createRedirect(
      admin(),
      { fromPath: existingFrom, toPath: '/pricing', statusCode: 301, active: true },
      { correlationId: 'c' },
    );
    const csv = [
      'path,target,status',
      `/services/monitoring-${sfx},/services/construction-monitoring,301`,
      `https://simplexd.co/old-form-${sfx}/,/book,308`,
      `/temp-${sfx},/explore,302`,
      `/services/monitoring-${sfx},/x,301`, // duplicate line
      `/bad-status-${sfx},/about,303`,
      `/about,/contact,301`, // live page
      `/admin/old-${sfx},/about,301`, // reserved
      `${existingFrom},/pricing,301`, // unchanged
      `${existingFrom},/other,301`, // conflicts with an existing row
      `/chain-${sfx},${existingFrom},301`, // chain
      `/no-target-${sfx},,301`,
      `/external-${sfx},https://old.example.test/archive,301`,
    ].join('\n');

    const preview = await importRedirects(admin(), { csv, dryRun: true }, { correlationId: 'c' });
    expect(preview.dryRun).toBe(true);
    expect(preview.summary).toEqual({
      total: 12,
      create: 4,
      created: 0,
      unchanged: 1,
      skip: 0,
      error: 7,
    });
    const byLine = Object.fromEntries(preview.rows.map((r) => [r.line, r]));
    expect(byLine[2]).toMatchObject({ outcome: 'create', fromPath: `/services/monitoring-${sfx}` });
    expect(byLine[3]).toMatchObject({ outcome: 'create', fromPath: `/old-form-${sfx}`, statusCode: 308 });
    expect(byLine[4]).toMatchObject({ outcome: 'create', statusCode: 302 });
    expect(byLine[5]).toMatchObject({ outcome: 'error', reason: 'duplicate of line 2' });
    expect(byLine[6]).toMatchObject({ outcome: 'error', reason: 'status must be 301, 302 or 308' });
    expect(byLine[7]!.reason).toContain('existing page');
    expect(byLine[8]!.reason).toContain('cannot be redirected');
    expect(byLine[9]).toMatchObject({ outcome: 'unchanged' });
    expect(byLine[10]!.reason).toContain('already exists');
    expect(byLine[11]!.reason).toContain('itself redirected');
    expect(byLine[12]).toMatchObject({ outcome: 'error' });
    expect(byLine[13]).toMatchObject({ outcome: 'create', toPath: 'https://old.example.test/archive' });
    // Nothing was written by the dry run.
    const none = await dbs.owner
      .select()
      .from(schema.redirects)
      .where(eq(schema.redirects.fromPath, `/temp-${sfx}`));
    expect(none).toHaveLength(0);

    const applied = await importRedirects(admin(), { csv, dryRun: false }, { correlationId: 'c' });
    expect(applied.summary.created).toBe(4);
    expect(applied.summary.error).toBe(7);
    const [temp] = await dbs.owner
      .select()
      .from(schema.redirects)
      .where(eq(schema.redirects.fromPath, `/temp-${sfx}`));
    expect(temp).toMatchObject({ toPath: '/explore', statusCode: 302, active: true, note: 'CSV import', createdBy: userId });
    const audit = await dbs.owner
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, temp!.id));
    expect(audit.map((a) => a.action)).toEqual(['redirect.created']);

    // Re-importing the same file is idempotent: everything valid is now unchanged.
    const again = await importRedirects(admin(), { csv, dryRun: true }, { correlationId: 'c' });
    expect(again.summary.unchanged).toBe(5);
    expect(again.summary.create).toBe(0);
  });

  it('accepts the site inventory format and imports only rows whose decision is redirect', async () => {
    const csv = [
      'source_url,status_code,title,content_type,decision,target_url,image_rights,owner,notes',
      `https://simplexd.co/inv-migrate-${sfx},200,Home,page,migrate,/,yes,owner,`,
      `https://simplexd.co/inv-redirect-${sfx},200,Old,service,redirect,/services/due-diligence,yes,owner,`,
      `https://simplexd.co/inv-drop-${sfx},200,Gone,article,drop,,no,owner,`,
    ].join('\n');
    const result = await importRedirects(admin(), { csv, dryRun: true }, { correlationId: 'c' });
    expect(result.rows.map((r) => r.outcome)).toEqual(['skip', 'create', 'skip']);
    expect(result.rows[1]).toMatchObject({ fromPath: `/inv-redirect-${sfx}`, toPath: '/services/due-diligence', statusCode: 301 });
  });

  it('rejects CSVs without the required columns or with no rows', async () => {
    await expect(
      importRedirects(admin(), { csv: 'a,b\n1,2', dryRun: true }, { correlationId: 'c' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      importRedirects(admin(), { csv: 'path,target,status\n', dryRun: true }, { correlationId: 'c' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('proxy endpoints', () => {
  it('exposes active redirects only and counts hits for active sources', async () => {
    const active = `/snap-active-${sfx}`;
    const inactive = `/snap-inactive-${sfx}`;
    await createRedirect(admin(), { fromPath: active, toPath: '/about', statusCode: 302, active: true }, { correlationId: 'c' });
    await createRedirect(admin(), { fromPath: inactive, toPath: '/about', statusCode: 301, active: false }, { correlationId: 'c' });

    const snapshot = await getRedirectSnapshot();
    expect(snapshot.items).toContainEqual({ from: active, to: '/about', status: 302 });
    expect(snapshot.items.some((i) => i.from === inactive)).toBe(false);
    expect(snapshot.items.every((i) => !('id' in i) && !('note' in i))).toBe(true);

    const routeRes = await snapshotRoute(new Request('http://localhost:3000/api/v1/redirects/snapshot'), {} as never);
    expect(routeRes.status).toBe(200);
    const body = (await routeRes.json()) as { items: Array<{ from: string }> };
    expect(body.items.some((i) => i.from === active)).toBe(true);

    expect(await recordRedirectHit(`${active}?utm=1`)).toBe(true);
    expect(await recordRedirectHit(inactive)).toBe(false);
    expect(await recordRedirectHit('/never-existed')).toBe(false);
    const hitRes = await hitRoute(
      new Request('http://localhost:3000/api/v1/redirects/hits', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
        body: JSON.stringify({ path: active }),
      }),
      {} as never,
    );
    expect(await hitRes.json()).toEqual({ counted: true });
    const [row] = await dbs.owner.select().from(schema.redirects).where(eq(schema.redirects.fromPath, active));
    expect(row!.hitCount).toBe(2);
  });
});
