import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabases, resetDatabase, type TestDatabases } from '@simplexd/db/testing';
import type { RequestIdentity } from '@/lib/auth/session';
import { createProject } from './projects';
import { createReport, releaseReport, reviewReport, submitReport } from './reports';
import { createFixtures, errorCode, staffIdentity, type ProjectFixtures } from './testing/fixtures';

/** Separation of duties: nobody reviews or releases their own report, whatever their role. */

let dbs: TestDatabases;
let f: ProjectFixtures;
let admin: RequestIdentity;
let ops: RequestIdentity;
let pm: RequestIdentity;
let projectId: string;

beforeAll(async () => {
  dbs = connectTestDatabases();
  await resetDatabase(dbs.owner);
  f = await createFixtures(dbs.owner);
  admin = staffIdentity(f.superAdmin, 'super_admin', true);
  ops = staffIdentity(f.ops, 'operations_manager');
  pm = staffIdentity(f.pm, 'project_manager');
  projectId = (
    await createProject(admin, {
      organizationId: f.orgA,
      name: 'Review rules',
      kind: 'snagging',
      pmUserId: f.pm.id,
    })
  ).id;
});

afterAll(async () => {
  await dbs.close();
});

describe('report author restrictions', () => {
  it('a super administrator author cannot review or release their own report', async () => {
    const report = await createReport(admin, projectId, {
      kind: 'snagging',
      title: 'Snag list',
      initialRevision: { bodyMarkdown: 'Items', attachmentFileIds: [] },
    });
    const submitted = await submitReport(admin, report.id, {
      namedReviewerUserId: f.ops.id,
      expectedVersion: 1,
    });
    expect(submitted.namedReviewerUserId).toBe(f.ops.id);
    expect(
      await errorCode(reviewReport(admin, report.id, { decision: 'approved', expectedVersion: 2 })),
    ).toMatch(/^forbidden/);
    const approved = await reviewReport(ops, report.id, {
      decision: 'approved',
      expectedVersion: 2,
    });
    expect(approved.status).toBe('approved');
    expect(await errorCode(releaseReport(admin, report.id, { expectedVersion: 3 }))).toMatch(
      /^forbidden/,
    );
    const released = await releaseReport(ops, report.id, { expectedVersion: 3 });
    expect(released.status).toBe('released');
    expect(released.releasedBy).toBe(f.ops.id);
  });

  it('a project manager author holding review and release permissions is equally blocked', async () => {
    const report = await createReport(pm, projectId, {
      kind: 'inspection',
      title: 'PM report',
      initialRevision: { bodyMarkdown: 'Body', attachmentFileIds: [] },
    });
    await submitReport(pm, report.id, { namedReviewerUserId: f.ops.id, expectedVersion: 1 });
    expect(
      await errorCode(reviewReport(pm, report.id, { decision: 'approved', expectedVersion: 2 })),
    ).toBe('forbidden:own_work');
    expect(await errorCode(releaseReport(pm, report.id, { expectedVersion: 2 }))).toBe(
      'forbidden:own_work',
    );
    // Operations managers hold no drafting permission, so they can never be an author here.
    expect(
      await errorCode(createReport(ops, projectId, { kind: 'inspection', title: 'Ops report' })),
    ).toMatch(/^forbidden/);
    await reviewReport(admin, report.id, { decision: 'approved', expectedVersion: 2 });
    expect(await errorCode(releaseReport(pm, report.id, { expectedVersion: 3 }))).toBe(
      'forbidden:own_work',
    );
    expect((await releaseReport(ops, report.id, { expectedVersion: 3 })).status).toBe('released');
  });
});
