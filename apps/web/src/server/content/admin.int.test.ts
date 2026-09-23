import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@simplexd/db';
import { connectTestDatabases, uniqueSuffix, type TestDatabases } from '@simplexd/db/testing';
import { staffIdentity } from '@/testing/identity';
import {
  applyContentAction,
  createContentPage,
  createContentRevision,
  getContentPageDetail,
  publishDueScheduledPages,
  renderPreviewHtml,
  resolvePublicContent,
} from './admin';
import { createRedirect, patchRedirect, resolveRedirect } from './redirects';

/**
 * CMS workflow: separation of duties on publish, rollback, scheduled
 * publication visibility, sanitiser behaviour and redirect resolution.
 */

let dbs: TestDatabases;
const sfx = uniqueSuffix();
const editorId = `cms_editor_${sfx}`;
const approverId = `cms_approver_${sfx}`;

const editor = () => staffIdentity({ userId: editorId, email: `${editorId}@example.test`, roles: ['content_editor'] });
const approver = () => staffIdentity({ userId: approverId, email: `${approverId}@example.test`, roles: ['content_editor'] });

beforeAll(async () => {
  dbs = connectTestDatabases();
  await dbs.owner.insert(schema.user).values([
    { id: editorId, name: 'Editor', email: `${editorId}@example.test` },
    { id: approverId, name: 'Approver', email: `${approverId}@example.test` },
  ]);
  await dbs.owner.insert(schema.staffRoles).values([
    { userId: editorId, role: 'content_editor' },
    { userId: approverId, role: 'content_editor' },
  ]);
});

afterAll(async () => {
  await dbs.close();
});

describe('publishing', () => {
  it('refuses to publish the author’s own revision and accepts a different approver', async () => {
    const page = await createContentPage(
      editor(),
      { slug: `about-${sfx}`, kind: 'page', title: 'About', bodyMarkdown: '## Hello\n\nFirst revision.', locale: 'en', sortOrder: 0 },
      { correlationId: 'c' },
    );
    expect(page.status).toBe('draft');
    expect(page.currentRevision).toBe(1);

    await expect(
      applyContentAction(editor(), page.id, { action: 'publish', expectedVersion: page.version }, { correlationId: 'c' }),
    ).rejects.toMatchObject({ code: 'forbidden', details: { code: 'separation_of_duties' } });

    expect(await resolvePublicContent(`about-${sfx}`)).toBeNull();

    const published = await applyContentAction(approver(), page.id, { action: 'publish', expectedVersion: page.version }, { correlationId: 'c' });
    expect(published.status).toBe('published');
    expect(published.publishedRevision).toBe(1);
    expect(published.version).toBe(page.version + 1);

    const live = await resolvePublicContent(`about-${sfx}`);
    expect(live?.bodyHtml).toContain('<h2>Hello</h2>');

    const audit = await dbs.owner
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.entityId, page.id), eq(schema.auditEvents.action, 'content.publish')));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorUserId).toBe(approverId);
    expect((audit[0]!.before as { status: string }).status).toBe('draft');
  });

  it('keeps serving the live revision after a new draft, then rolls back to an earlier published revision', async () => {
    const page = await createContentPage(
      editor(),
      { slug: `rollback-${sfx}`, kind: 'page', title: 'Rollback', bodyMarkdown: 'Version one.', locale: 'en', sortOrder: 0 },
      { correlationId: 'c' },
    );
    const v1 = await applyContentAction(approver(), page.id, { action: 'publish', expectedVersion: page.version }, { correlationId: 'c' });

    const { page: afterRev2 } = await createContentRevision(
      editor(),
      page.id,
      { title: 'Rollback', bodyMarkdown: 'Version two.', expectedVersion: v1.version },
      { correlationId: 'c' },
    );
    expect(afterRev2.currentRevision).toBe(2);
    expect(afterRev2.publishedRevision).toBe(1);
    expect((await resolvePublicContent(`rollback-${sfx}`))?.bodyMarkdown).toBe('Version one.');

    const v2 = await applyContentAction(approver(), page.id, { action: 'publish', revision: 2, expectedVersion: afterRev2.version }, { correlationId: 'c' });
    expect(v2.publishedRevision).toBe(2);
    expect((await resolvePublicContent(`rollback-${sfx}`))?.bodyMarkdown).toBe('Version two.');

    const rolledBack = await applyContentAction(approver(), page.id, { action: 'rollback', revision: 1, expectedVersion: v2.version }, { correlationId: 'c' });
    expect(rolledBack.publishedRevision).toBe(1);
    expect(rolledBack.currentRevision).toBe(2);
    expect((await resolvePublicContent(`rollback-${sfx}`))?.bodyMarkdown).toBe('Version one.');

    const audit = await dbs.owner
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.entityId, page.id), eq(schema.auditEvents.action, 'content.rolled_back')));
    expect(audit).toHaveLength(1);

    const detail = await getContentPageDetail(approver(), page.id);
    expect(detail.revisions.map((r) => r.revision)).toEqual([2, 1]);
  });

  it('rejects a stale expectedVersion', async () => {
    const page = await createContentPage(
      editor(),
      { slug: `stale-${sfx}`, kind: 'page', title: 'Stale', bodyMarkdown: 'x', locale: 'en', sortOrder: 0 },
      { correlationId: 'c' },
    );
    await expect(
      applyContentAction(approver(), page.id, { action: 'publish', expectedVersion: page.version + 1 }, { correlationId: 'c' }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
  });
});

describe('scheduled publication', () => {
  it('is visible only once publishAt has passed and is materialised by the scheduler', async () => {
    const page = await createContentPage(
      editor(),
      { slug: `scheduled-${sfx}`, kind: 'page', title: 'Scheduled', bodyMarkdown: 'Later.', locale: 'en', sortOrder: 0 },
      { correlationId: 'c' },
    );
    const publishAt = new Date(Date.now() + 3_600_000);
    await expect(
      applyContentAction(approver(), page.id, { action: 'schedule', publishAt: new Date(Date.now() - 1000).toISOString(), expectedVersion: page.version }, { correlationId: 'c' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });

    const scheduled = await applyContentAction(approver(), page.id, { action: 'schedule', publishAt: publishAt.toISOString(), expectedVersion: page.version }, { correlationId: 'c' });
    expect(scheduled.status).toBe('scheduled');
    expect(scheduled.publishAt).toBe(publishAt.toISOString());

    expect(await resolvePublicContent(`scheduled-${sfx}`, new Date())).toBeNull();
    expect((await resolvePublicContent(`scheduled-${sfx}`, new Date(publishAt.getTime() + 1000)))?.title).toBe('Scheduled');

    expect(await publishDueScheduledPages(new Date())).toBe(0);
    const promoted = await publishDueScheduledPages(new Date(publishAt.getTime() + 60_000));
    expect(promoted).toBeGreaterThanOrEqual(1);
    const detail = await getContentPageDetail(approver(), page.id);
    expect(detail.status).toBe('published');
    expect(detail.publishAt).toBeNull();
    expect((await resolvePublicContent(`scheduled-${sfx}`, new Date()))?.title).toBe('Scheduled');
  });
});

describe('sanitiser', () => {
  it('strips scripts, event handlers and javascript: links from saved revisions and previews', async () => {
    const hostile = [
      '# Title',
      '<script>alert(1)</script>',
      '<img src="https://example.test/a.png" onerror="alert(1)" alt="x">',
      '[click](javascript:alert(1))',
      '<a href="https://example.test" onclick="steal()">ok</a>',
      '<iframe src="https://evil.test"></iframe>',
    ].join('\n\n');
    const page = await createContentPage(
      editor(),
      { slug: `hostile-${sfx}`, kind: 'page', title: 'Hostile', bodyMarkdown: hostile, locale: 'en', sortOrder: 0 },
      { correlationId: 'c' },
    );
    const detail = await getContentPageDetail(editor(), page.id);
    const html = detail.revisions[0]!.bodyHtmlSanitized ?? '';
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/onerror|onclick/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/<iframe/i);
    expect(html).toContain('<img');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('ok</a>');

    const preview = renderPreviewHtml(hostile);
    expect(preview).toBe(html);
  });
});

describe('redirects', () => {
  it('creates, resolves (cached) and toggles redirects', async () => {
    const from = `/old-${sfx}`;
    const created = await createRedirect(approver(), { fromPath: from, toPath: `/new-${sfx}`, statusCode: 301, active: true }, { correlationId: 'c' });
    expect(await resolveRedirect(`${from}?utm=1`)).toEqual({ toPath: `/new-${sfx}`, statusCode: 301 });
    await expect(createRedirect(approver(), { fromPath: from, toPath: '/x', statusCode: 301, active: true }, { correlationId: 'c' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(createRedirect(approver(), { fromPath: `/new-${sfx}`, toPath: from, statusCode: 301, active: true }, { correlationId: 'c' })).rejects.toMatchObject({ code: 'validation_failed' });
    await patchRedirect(approver(), created.id, { active: false }, { correlationId: 'c' });
    expect(await resolveRedirect(from)).toBeNull();
  });
});
