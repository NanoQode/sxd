import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, schema } from '@simplexd/db';
import { connectTestDatabases, type TestDatabases } from '@simplexd/db/testing';
import type { RequestIdentity } from '@/lib/auth/session';
import { acceptAssignment, proposeAssignment } from '@/server/assignments/service';
import { createProject } from './projects';
import {
  rejectUnscheduledSiteVisit,
  reviewSiteVisit,
  scheduleSiteVisit,
  startUnscheduledSiteVisit,
  submitSiteVisit,
  syncSiteVisits,
} from './site-visits';
import {
  createFixtures,
  customerIdentity,
  errorCode,
  partnerIdentity,
  staffIdentity,
  type ProjectFixtures,
} from './testing/fixtures';

/**
 * Unscheduled visits: an inspector with an active field assignment may start
 * one with a reason; it is flagged, staff are told, and staff may reject it
 * until its findings are reviewed.
 */

let dbs: TestDatabases;
let f: ProjectFixtures;
let admin: RequestIdentity;
let ops: RequestIdentity;
let pm: RequestIdentity;
let partner: RequestIdentity;
let projectId: string;

beforeAll(async () => {
  dbs = connectTestDatabases();
  f = await createFixtures(dbs.owner);
  admin = staffIdentity(f.superAdmin, 'super_admin', true);
  ops = staffIdentity(f.ops, 'operations_manager');
  pm = staffIdentity(f.pm, 'project_manager');
  partner = partnerIdentity(f.partner);
  projectId = (
    await createProject(admin, {
      organizationId: f.orgA,
      name: 'Ajah duplex',
      kind: 'construction_monitoring',
      pmUserId: f.pm.id,
    })
  ).id;
});

afterAll(async () => {
  await closeDb();
  await dbs.close();
});

describe('unscheduled site visits', () => {
  it('needs an active field assignment on the project and a reason', async () => {
    const start = (identity: RequestIdentity, offlineClientId?: string) =>
      startUnscheduledSiteVisit(identity, projectId, {
        reason: 'Site foreman reported a cracked lintel on the first floor',
        offlineClientId,
      });
    // No assignment: the project is not even visible to the partner.
    expect(await errorCode(start(partner))).toMatch(/not_found|forbidden/);
    // A legal assignment is not field work.
    const legal = await proposeAssignment(ops, {
      projectId,
      assigneeUserId: f.partner.id,
      role: 'legal',
    });
    await acceptAssignment(partner, legal.id);
    expect(await errorCode(start(partner))).toBe('forbidden');
    const inspector = await proposeAssignment(ops, {
      projectId,
      assigneeUserId: f.partner.id,
      role: 'inspector',
    });
    // A proposed assignment grants nothing until accepted.
    expect(await errorCode(start(partner))).toBe('forbidden');
    await acceptAssignment(partner, inspector.id);

    // Offline sync path: a partner-created field visit must carry a reason.
    const sync = await syncSiteVisits(partner, {
      items: [
        {
          offlineClientId: `visit_${f.partner.id}_noreason`,
          projectId,
          findingsMarkdown: 'Cracks noted',
          evidenceFileIds: [],
        },
      ],
    });
    expect(sync.results[0]).toMatchObject({ outcome: 'rejected', code: 'validation_failed' });

    const visit = await start(partner, `visit_${f.partner.id}_unsched1`);
    expect(visit).toMatchObject({
      status: 'in_progress',
      unscheduled: true,
      unscheduledReason: 'Site foreman reported a cracked lintel on the first floor',
      scheduledAt: null,
      inspectorUserId: f.partner.id,
      projectId,
      idempotentReplay: false,
      instructions: null,
    });
    expect(visit.startedAt).not.toBeNull();
    const replay = await start(partner, `visit_${f.partner.id}_unsched1`);
    expect(replay).toMatchObject({ id: visit.id, idempotentReplay: true });
    const [event] = await dbs.owner
      .select()
      .from(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.eventType, 'project.site_visit.unscheduled_started'),
          eq(schema.outboxEvents.aggregateId, visit.id),
        ),
      );
    expect(event?.payload).toMatchObject({
      inspectorUserId: f.partner.id,
      pmUserId: f.pm.id,
      recipientUserIds: [f.pm.id],
    });
    const [audit] = await dbs.owner
      .select({ action: schema.auditEvents.action, reason: schema.auditEvents.reason })
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.entityType, 'site_visit'),
          eq(schema.auditEvents.entityId, visit.id),
        ),
      );
    expect(audit).toMatchObject({ action: 'site_visit.started_unscheduled' });
    expect(audit?.reason).toContain('cracked lintel');

    // Customers never start visits; an unassigned staff inspector is blocked by the relationship rule.
    expect(await errorCode(start(customerIdentity(f, f.ownerA, 'owner')))).toMatch(
      /forbidden|not_found/,
    );
    expect(await errorCode(start(staffIdentity(f.inspector2, 'inspector')))).toBe(
      'forbidden:not_assigned',
    );
    // The offline sync path also creates an unscheduled visit once a reason is given.
    const synced = await syncSiteVisits(partner, {
      items: [
        {
          offlineClientId: `visit_${f.partner.id}_sync2`,
          projectId,
          unscheduledReason: 'Delivery of blocks arrived unannounced; checking quality',
          findingsMarkdown: 'Blocks are within tolerance',
          evidenceFileIds: [],
        },
      ],
    });
    expect(synced.results[0]).toMatchObject({ outcome: 'created' });
    const [row] = await dbs.owner
      .select({ scheduledAt: schema.siteVisits.scheduledAt, status: schema.siteVisits.status })
      .from(schema.siteVisits)
      .where(eq(schema.siteVisits.id, synced.results[0]!.siteVisitId!));
    expect(row).toMatchObject({ scheduledAt: null, status: 'submitted' });
  });

  it('staff reject an unscheduled visit until it is reviewed; never the inspector, never a scheduled visit', async () => {
    const visit = await startUnscheduledSiteVisit(partner, projectId, {
      reason: 'Neighbour complained about vibration from piling',
    });
    expect(await errorCode(rejectUnscheduledSiteVisit(partner, visit.id, { reason: 'x' }))).toMatch(
      /^forbidden/,
    );
    const submitted = await submitSiteVisit(partner, visit.id, {
      findingsMarkdown: 'Vibration within limits; no cracks in the boundary wall.',
      evidenceFileIds: [],
    });
    expect(submitted.status).toBe('submitted');
    const rejected = await rejectUnscheduledSiteVisit(pm, visit.id, {
      reason: 'Not within the monitoring scope; the structural engineer covers piling',
    });
    expect(rejected).toMatchObject({ id: visit.id, status: 'cancelled', unscheduled: true });
    const [event] = await dbs.owner
      .select()
      .from(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.eventType, 'project.site_visit.rejected'),
          eq(schema.outboxEvents.aggregateId, visit.id),
        ),
      );
    expect(event?.payload).toMatchObject({ recipientUserIds: [f.partner.id] });

    // Once reviewed, a visit is history: it can no longer be rejected.
    const reviewedVisit = await startUnscheduledSiteVisit(partner, projectId, {
      reason: 'Roof trusses delivered; checking the timber grade',
    });
    await submitSiteVisit(partner, reviewedVisit.id, {
      findingsMarkdown: 'Grade stamps present on every truss.',
      evidenceFileIds: [],
    });
    await reviewSiteVisit(ops, reviewedVisit.id, { note: 'ok' });
    expect(
      await errorCode(rejectUnscheduledSiteVisit(ops, reviewedVisit.id, { reason: 'late' })),
    ).toBe('invalid_transition');

    // Scheduled visits are cancelled, not rejected.
    const scheduled = await scheduleSiteVisit(admin, projectId, {
      inspectorUserId: f.inspector.id,
      scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(scheduled.unscheduled).toBe(false);
    expect(await errorCode(rejectUnscheduledSiteVisit(ops, scheduled.id, { reason: 'no' }))).toBe(
      'invalid_transition',
    );
  });
});
