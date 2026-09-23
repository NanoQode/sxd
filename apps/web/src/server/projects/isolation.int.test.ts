import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@simplexd/db';
import { connectTestDatabases, resetDatabase, type TestDatabases } from '@simplexd/db/testing';
import type { RequestIdentity } from '@/lib/auth/session';
import { listApprovals, listPendingApprovals } from './approvals';
import { createBudgetVersion, getBudgetVariance, getBudgetVersion } from './budgets';
import { createChangeOrder, getChangeOrder } from './change-orders';
import { createDefect, getDefect } from './defects';
import {
  addDesignComment,
  createDesignOption,
  createDesignOptionVersion,
  getDesignOption,
  signOffDesignOption,
  updateDesignOption,
} from './design';
import { createMilestone, getMilestone } from './milestones';
import { addPermitEvent, createPermit, getPermit } from './permits';
import {
  createProject,
  getProject,
  getProjectOverview,
  listProjects,
  updateProject,
} from './projects';
import { createReport, getReport } from './reports';
import { getSchedule } from './schedule';
import { getSiteVisit, scheduleSiteVisit } from './site-visits';
import {
  createFixtures,
  customerIdentity,
  errorCode,
  partnerIdentity,
  staffIdentity,
  type ProjectFixtures,
} from './testing/fixtures';

/** Cross-organisation and assignment denial (brief §11 and §19 threat model). */

let dbs: TestDatabases;
let f: ProjectFixtures;
let admin: RequestIdentity;
let pm: RequestIdentity;
let pm2: RequestIdentity;
let ownerA: RequestIdentity;
let ownerB: RequestIdentity;
let partner: RequestIdentity;
const ids: Record<string, string> = {};

beforeAll(async () => {
  dbs = connectTestDatabases();
  await resetDatabase(dbs.owner);
  f = await createFixtures(dbs.owner);
  admin = staffIdentity(f.superAdmin, 'super_admin', true);
  pm = staffIdentity(f.pm, 'project_manager');
  pm2 = staffIdentity(f.pm2, 'project_manager');
  ownerA = customerIdentity(f, f.ownerA, 'owner');
  ownerB = customerIdentity(f, f.ownerB, 'owner', f.orgB);
  partner = partnerIdentity(f.partner);
  const p = await createProject(admin, {
    organizationId: f.orgA,
    name: 'Org A project',
    kind: 'architecture',
    pmUserId: f.pm.id,
  });
  ids.project = p.id;
  ids.budget = (await createBudgetVersion(pm, p.id, { source: 'manual', totalKobo: '1000' })).id;
  ids.milestone = (await createMilestone(pm, p.id, { name: 'M1' })).id;
  ids.visit = (
    await scheduleSiteVisit(pm, p.id, {
      inspectorUserId: f.inspector.id,
      scheduledAt: '2026-11-01T09:00:00.000Z',
    })
  ).id;
  ids.report = (
    await createReport(pm, p.id, {
      kind: 'progress',
      title: 'R1',
      initialRevision: { bodyMarkdown: 'x', attachmentFileIds: [] },
    })
  ).id;
  ids.defect = (
    await createDefect(pm, p.id, {
      title: 'Crack in wall',
      severity: 'minor',
      accountableParty: 'contractor',
    })
  ).id;
  ids.changeOrder = (
    await createChangeOrder(pm, p.id, {
      title: 'CO',
      amountDeltaKobo: '1',
      scheduleDeltaDays: 0,
      requiresCustomerApproval: true,
      requiresStaffApproval: true,
    })
  ).id;
  ids.design = (await createDesignOption(pm, p.id, { title: 'Option A', drawingFileIds: [] })).id;
  ids.permit = (
    await createPermit(pm, p.id, {
      jurisdiction: 'Lagos',
      authority: 'LASPPPA',
      permitType: 'building_permit',
    })
  ).id;
});

afterAll(async () => {
  await dbs.close();
});

describe('a member of another organisation', () => {
  it('cannot see or touch any org A record', async () => {
    const attempts: Array<[string, () => Promise<unknown>]> = [
      ['project', () => getProject(ownerB, ids.project!)],
      ['overview', () => getProjectOverview(ownerB, ids.project!)],
      ['schedule', () => getSchedule(ownerB, ids.project!)],
      ['variance', () => getBudgetVariance(ownerB, ids.project!)],
      ['budget', () => getBudgetVersion(ownerB, ids.budget!)],
      ['milestone', () => getMilestone(ownerB, ids.milestone!)],
      ['visit', () => getSiteVisit(ownerB, ids.visit!)],
      ['report', () => getReport(ownerB, ids.report!)],
      ['defect', () => getDefect(ownerB, ids.defect!)],
      ['changeOrder', () => getChangeOrder(ownerB, ids.changeOrder!)],
      ['design', () => getDesignOption(ownerB, ids.design!)],
      ['permit', () => getPermit(ownerB, ids.permit!)],
      [
        'approvals',
        () => listApprovals(ownerB, { entityType: 'change_order', entityId: ids.changeOrder! }),
      ],
      [
        'update',
        () => updateProject(ownerB, ids.project!, { name: 'Hijacked', expectedVersion: 1 }),
      ],
      ['comment', () => addDesignComment(ownerB, ids.design!, { body: 'hi' })],
    ];
    for (const [label, p] of attempts) {
      const code = await errorCode(p());
      expect(`${label}:${code}`).toMatch(/:(not_found|forbidden)/);
    }
    expect((await listProjects(ownerB, { limit: 25 })).items).toHaveLength(0);
    expect((await listPendingApprovals(ownerB)).items).toHaveLength(0);
    // Row-level security hides the rows even for a direct read under org B's context.
    const rows = await dbs.app.transaction(async (tx) => {
      const { applyActorContext } = await import('@simplexd/db');
      await applyActorContext(tx, { userId: f.ownerB.id, organizationId: f.orgB, staff: false });
      return tx.select().from(schema.projects);
    });
    expect(rows).toHaveLength(0);
  });

  it('cannot approve org A budgets even with the approver permission in its own organisation', async () => {
    const { decideBudgetVersion } = await import('./budgets');
    expect(
      await errorCode(decideBudgetVersion(ownerB, ids.budget!, { decision: 'approved' })),
    ).toMatch(/not_found|forbidden/);
  });
});

describe('staff and partner assignment rules', () => {
  it('denies an unassigned project manager and allows the assigned one', async () => {
    expect(await errorCode(getProject(pm2, ids.project!))).toBe('forbidden:not_assigned');
    expect(
      await errorCode(updateProject(pm2, ids.project!, { name: 'Nope', expectedVersion: 1 })),
    ).toBe('forbidden:not_assigned');
    expect(await errorCode(createMilestone(pm2, ids.project!, { name: 'M2' }))).toBe(
      'forbidden:not_assigned',
    );
    expect((await listProjects(pm2, { limit: 25 })).items).toHaveLength(0);
    expect((await getProject(pm, ids.project!)).id).toBe(ids.project);
    // Ops managers reach every project; a customer owner reads but cannot manage.
    expect((await getProject(staffIdentity(f.ops, 'operations_manager'), ids.project!)).id).toBe(
      ids.project,
    );
    expect(
      await errorCode(
        updateProject(ownerA, ids.project!, { name: 'Renamed by customer', expectedVersion: 1 }),
      ),
    ).toMatch(/^forbidden/);
  });

  it('denies an unassigned partner and admits them only through an accepted assignment', async () => {
    expect(await errorCode(getProject(partner, ids.project!))).toMatch(/not_found|forbidden/);
    expect(
      await errorCode(createReport(partner, ids.project!, { kind: 'progress', title: 'P' })),
    ).toMatch(/not_found|forbidden/);
    const [assignment] = await dbs.owner
      .insert(schema.assignments)
      .values({
        organizationId: f.orgA,
        projectId: ids.project!,
        assigneeUserId: f.partner.id,
        role: 'contractor',
        status: 'proposed',
      })
      .returning({ id: schema.assignments.id });
    // Proposed is not yet accepted: still denied for partners.
    expect(await errorCode(getProject(partner, ids.project!))).toMatch(/not_found|forbidden/);
    const { eq } = await import('drizzle-orm');
    await dbs.owner
      .update(schema.assignments)
      .set({ status: 'accepted' })
      .where(eq(schema.assignments.id, assignment!.id));
    expect((await getProject(partner, ids.project!)).id).toBe(ids.project);
    const report = await createReport(partner, ids.project!, {
      kind: 'progress',
      title: 'Partner report',
      initialRevision: { bodyMarkdown: 'Site works', attachmentFileIds: [] },
    });
    expect(report.createdBy).toBe(f.partner.id);
    // Partners never manage budgets or approve anything.
    expect(
      await errorCode(
        createBudgetVersion(partner, ids.project!, { source: 'manual', totalKobo: '1' }),
      ),
    ).toMatch(/^forbidden/);
  });

  it('keeps a signed-off design version immutable and tracks permit statutory targets honestly', async () => {
    const comment = await addDesignComment(ownerA, ids.design!, {
      body: 'Move the kitchen window',
      anchor: { fileId: f.fileClean, page: 1, x: 0.4, y: 0.2 },
    });
    expect(comment.authorUserId).toBe(f.ownerA.id);
    expect(
      await errorCode(
        signOffDesignOption(customerIdentity(f, f.memberA, 'member'), ids.design!, {
          confirm: true,
        }),
      ),
    ).toMatch(/^forbidden/);
    const signed = await signOffDesignOption(ownerA, ids.design!, { confirm: true });
    expect(signed.status).toBe('signed_off');
    expect(await errorCode(updateDesignOption(pm, ids.design!, { description: 'changed' }))).toBe(
      'conflict',
    );
    expect(await errorCode(signOffDesignOption(ownerA, ids.design!, { confirm: true }))).toBe(
      'conflict',
    );
    const v2 = await createDesignOptionVersion(pm, ids.design!, {
      drawingFileIds: [],
      reason: 'Window moved',
    });
    expect(v2.version).toBe(2);
    expect(v2.isCurrentVersion).toBe(true);
    const old = await getDesignOption(ownerA, ids.design!);
    expect(old.status).toBe('signed_off');
    expect(old.customerSignoffBy).toBe(f.ownerA.id);
    expect(old.isCurrentVersion).toBe(false);

    const permit = await getPermit(ownerA, ids.permit!);
    expect(permit.statutoryTargetStatus).toBe('unknown');
    expect(permit.statutoryTarget).toBeNull();
    expect(
      await errorCode(
        addPermitEvent(pm, ids.permit!, { eventType: 'query_raised', occurredAt: '2026-08-02' }),
      ),
    ).toBe('invalid_transition');
    await addPermitEvent(pm, ids.permit!, { eventType: 'submitted', occurredAt: '2026-08-02' });
    const queried = await addPermitEvent(pm, ids.permit!, {
      eventType: 'query_raised',
      occurredAt: '2026-08-09',
      note: 'Missing survey plan',
    });
    expect(queried.status).toBe('query_raised');
    expect(queried.elapsed?.authorityDays).toBe(7);
    expect(queried.events.map((e) => e.eventType)).toEqual(['submitted', 'query_raised']);
    const { eq } = await import('drizzle-orm');
    await expect(
      dbs.owner
        .delete(schema.permitEvents)
        .where(eq(schema.permitEvents.permitApplicationId, ids.permit!)),
    ).rejects.toSatisfy((err: unknown) => {
      const e = err as { message?: string; cause?: { message?: string } };
      return /append-only/.test(`${e.message ?? ''} ${e.cause?.message ?? ''}`);
    });
  });
});
