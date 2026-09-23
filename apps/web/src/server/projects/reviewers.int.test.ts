import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb } from '@simplexd/db';
import { connectTestDatabases, type TestDatabases } from '@simplexd/db/testing';
import { createProject } from './projects';
import { REVIEWER_ROLES, listReviewers } from './reviewers';
import {
  createFixtures,
  customerIdentity,
  errorCode,
  partnerIdentity,
  staffIdentity,
  type ProjectFixtures,
} from './testing/fixtures';

/** The reviewer directory: who may be named as a report's professional reviewer. */

let dbs: TestDatabases;
let f: ProjectFixtures;
let projectId: string;

beforeAll(async () => {
  dbs = connectTestDatabases();
  f = await createFixtures(dbs.owner);
  projectId = (
    await createProject(staffIdentity(f.superAdmin, 'super_admin', true), {
      organizationId: f.orgA,
      name: 'Reviewer directory',
      kind: 'snagging',
      pmUserId: f.pm.id,
    })
  ).id;
});

afterAll(async () => {
  await closeDb();
  await dbs.close();
});

describe('GET /reviewers', () => {
  it('derives the reviewing roles from the permission matrix', () => {
    expect(REVIEWER_ROLES).toEqual(
      expect.arrayContaining(['super_admin', 'operations_manager', 'project_manager']),
    );
    expect(REVIEWER_ROLES).not.toContain('inspector');
    expect(REVIEWER_ROLES).not.toContain('finance');
  });

  it('lists staff with reports.review, excluding the requester and non-reviewers', async () => {
    const { items } = await listReviewers(staffIdentity(f.pm, 'project_manager'), {});
    const ids = items.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([f.ops.id, f.superAdmin.id, f.pm2.id]));
    expect(ids).not.toContain(f.pm.id);
    expect(ids).not.toContain(f.inspector.id);
    expect(ids).not.toContain(f.finance.id);
    expect(ids).not.toContain(f.ownerA.id);
    for (const r of items) {
      expect(Object.keys(r).sort()).toEqual(['id', 'isProjectManager', 'name', 'role']);
      expect(r.role).not.toBe('inspector');
    }
  });

  it('marks the project manager first when a project is given and the caller can see it', async () => {
    const { items } = await listReviewers(staffIdentity(f.ops, 'operations_manager'), {
      projectId,
    });
    expect(items[0]).toMatchObject({
      id: f.pm.id,
      isProjectManager: true,
      role: 'project_manager',
    });
    expect(items.filter((r) => r.isProjectManager)).toHaveLength(1);
    // A partner not assigned to the project cannot resolve its manager, but still gets the directory.
    const partnerView = await listReviewers(partnerIdentity(f.partner), { projectId });
    expect(partnerView.items.length).toBeGreaterThan(0);
    expect(partnerView.items.every((r) => !r.isProjectManager)).toBe(true);
    expect(partnerView.items.map((r) => r.id)).toContain(f.pm.id);
  });

  it('is unavailable to customers', async () => {
    expect(await errorCode(listReviewers(customerIdentity(f, f.ownerA, 'owner'), {}))).toBe(
      'forbidden',
    );
    expect(await errorCode(listReviewers(customerIdentity(f, f.adviserA, 'adviser'), {}))).toBe(
      'forbidden',
    );
  });
});
