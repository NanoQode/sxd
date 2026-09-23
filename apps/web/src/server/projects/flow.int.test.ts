import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@simplexd/db';
import { connectTestDatabases, resetDatabase, type TestDatabases } from '@simplexd/db/testing';
import type { RequestIdentity } from '@/lib/auth/session';
import { createBudgetVersion, decideBudgetVersion, getBudgetVariance, addCommitment } from './budgets';
import { createDefect, getUnresolvedIssues, transitionDefect } from './defects';
import { linkEvidence, listEvidence, setEvidencePublication } from './evidence';
import { authorizeMilestonePayment, createMilestone, decideMilestone, recordMilestoneProgress, submitMilestone } from './milestones';
import { createProject, getProjectOverview, listProjects, transitionProject } from './projects';
import { addReportRevision, createReport, getReport, listReports, releaseReport, reviewReport, submitReport } from './reports';
import { replaceSchedule } from './schedule';
import { scheduleSiteVisit, startSiteVisit, submitSiteVisit, syncSiteVisits } from './site-visits';
import { createFixtures, customerIdentity, errorCode, staffIdentity, type ProjectFixtures } from './testing/fixtures';

/**
 * Acceptance flow (brief §21 scenarios 3, 10, 12 and the construction module
 * of §8): project → budget approval → schedule baseline → milestone actions →
 * site visit with offline replay → report review and release → customer reads
 * released reports only.
 */

let dbs: TestDatabases;
let f: ProjectFixtures;
let admin: RequestIdentity;
let pm: RequestIdentity;
let inspector: RequestIdentity;
let ops: RequestIdentity;
let finance: RequestIdentity;
let ownerA: RequestIdentity;
let approverA: RequestIdentity;
let memberA: RequestIdentity;
let projectId: string;

beforeAll(async () => {
  dbs = connectTestDatabases();
  await resetDatabase(dbs.owner);
  f = await createFixtures(dbs.owner);
  admin = staffIdentity(f.superAdmin, 'super_admin', true);
  pm = staffIdentity(f.pm, 'project_manager');
  inspector = staffIdentity(f.inspector, 'inspector');
  ops = staffIdentity(f.ops, 'operations_manager');
  finance = staffIdentity(f.finance, 'finance', true);
  ownerA = customerIdentity(f, f.ownerA, 'owner');
  approverA = customerIdentity(f, f.approverA, 'approver');
  memberA = customerIdentity(f, f.memberA, 'member');
});

afterAll(async () => {
  await dbs.close();
});

describe('project delivery flow', () => {
  it('creates a project with an assigned PM and customer contact', async () => {
    const p = await createProject(admin, {
      organizationId: f.orgA,
      name: 'Lekki duplex monitoring',
      kind: 'construction_monitoring',
      pmUserId: f.pm.id,
      customerContactUserId: f.ownerA.id,
      startDate: '2026-10-05',
      grossFloorAreaM2: '350.00',
    });
    projectId = p.id;
    expect(p.status).toBe('planning');
    // The assigned inspector reaches the project only through an assignment row.
    await dbs.owner.insert(schema.assignments).values({
      organizationId: f.orgA,
      projectId,
      assigneeUserId: f.inspector.id,
      role: 'inspector',
      status: 'accepted',
      assignedBy: f.superAdmin.id,
    });
    expect((await listProjects(pm, { limit: 25 })).items.map((x) => x.id)).toEqual([projectId]);
    expect((await listProjects(ownerA, { limit: 25 })).items.map((x) => x.id)).toEqual([projectId]);
    const active = await transitionProject(pm, projectId, { to: 'active', expectedVersion: 1 });
    expect(active.status).toBe('active');
    expect(await errorCode(transitionProject(pm, projectId, { to: 'on_hold', expectedVersion: 2 }))).toBe('invalid_transition');
  });

  it('approves a BOQ budget only with both customer and staff approval, with server-computed totals', async () => {
    const draft = await createBudgetVersion(pm, projectId, {
      source: 'boq',
      contingencyKobo: '500000',
      items: [
        { description: 'Blockwork', unit: 'm2', quantity: '120.5', rateKobo: '850000' },
        { description: 'Roofing sheets', unit: 'm2', quantity: '80', rateKobo: '1200000', sortOrder: 1 },
      ],
    });
    expect(draft.status).toBe('draft');
    expect(draft.items[0]!.amountKobo).toBe('102425000');
    expect(draft.totalKobo).toBe((102_425_000n + 96_000_000n).toString());
    expect(draft.approvalPolicy.missing).toEqual(['customer', 'staff']);
    // A customer member cannot approve; an approver can. Staff approval alone does not approve.
    expect(await errorCode(decideBudgetVersion(memberA, draft.id, { decision: 'approved' }))).toMatch(/^forbidden/);
    const afterStaff = await decideBudgetVersion(pm, draft.id, { decision: 'approved' });
    expect(afterStaff.status).toBe('draft');
    expect(afterStaff.approvalPolicy.missing).toEqual(['customer']);
    const approved = await decideBudgetVersion(approverA, draft.id, { decision: 'approved' });
    expect(approved.status).toBe('approved');
    expect(approved.approvedByCustomerUserId).toBe(f.approverA.id);
    expect(approved.approvedByStaffUserId).toBe(f.pm.id);
    const [project] = await dbs.owner.select().from(schema.projects).where(eq(schema.projects.id, projectId));
    expect(project!.approvedBudgetVersionId).toBe(draft.id);
    await addCommitment(pm, projectId, { kind: 'commitment', description: 'Blockwork contract', amountKobo: '90000000', currency: 'NGN' });
    await addCommitment(pm, projectId, { kind: 'actual', description: 'Deposit paid', amountKobo: '30000000', currency: 'NGN' });
    const variance = await getBudgetVariance(ownerA, projectId);
    expect(variance.approvedTotalKobo).toBe((198_425_000n + 500_000n).toString());
    expect(variance.committedKobo).toBe('90000000');
    expect(variance.forecastFinalCostKobo).toBe(variance.approvedTotalKobo);
    expect(variance.status).toBe('within_budget');
  });

  it('rejects dependency cycles and stores a computed baseline with the critical path', async () => {
    const cyc = await errorCode(
      replaceSchedule(pm, projectId, {
        tasks: [
          { key: 'a', name: 'A', phase: 'design', durationDaysLikely: 5, calendarBasis: 'calendar_days', leadTimeDays: 0, accountableParty: 'unknown', isMilestone: false, percentComplete: 0 },
          { key: 'b', name: 'B', phase: 'structure', durationDaysLikely: 5, calendarBasis: 'calendar_days', leadTimeDays: 0, accountableParty: 'unknown', isMilestone: false, percentComplete: 0 },
        ],
        dependencies: [
          { predecessorKey: 'a', successorKey: 'b', type: 'finish_to_start', lagDays: 0 },
          { predecessorKey: 'b', successorKey: 'a', type: 'finish_to_start', lagDays: 0 },
        ],
      }),
    );
    expect(cyc).toBe('validation_failed');
    const s = await replaceSchedule(pm, projectId, {
      tasks: [
        { key: 'design', name: 'Design', phase: 'design', durationDaysLikely: 5, calendarBasis: 'calendar_days', leadTimeDays: 0, accountableParty: 'consultant', isMilestone: false, percentComplete: 0 },
        { key: 'foundations', name: 'Foundations', phase: 'foundations', durationDaysLikely: 10, calendarBasis: 'calendar_days', leadTimeDays: 0, accountableParty: 'contractor', isMilestone: false, percentComplete: 0 },
        { key: 'approvals', name: 'Approvals', phase: 'approvals', durationDaysLikely: 4, calendarBasis: 'calendar_days', leadTimeDays: 0, accountableParty: 'authority', isMilestone: false, percentComplete: 0 },
        { key: 'roof', name: 'Roof', phase: 'roof', durationDaysLikely: 3, calendarBasis: 'calendar_days', leadTimeDays: 0, accountableParty: 'contractor', isMilestone: false, percentComplete: 0 },
      ],
      dependencies: [
        { predecessorKey: 'design', successorKey: 'foundations', type: 'finish_to_start', lagDays: 0 },
        { predecessorKey: 'design', successorKey: 'approvals', type: 'finish_to_start', lagDays: 0 },
        { predecessorKey: 'foundations', successorKey: 'roof', type: 'finish_to_start', lagDays: 0 },
        { predecessorKey: 'approvals', successorKey: 'roof', type: 'finish_to_start', lagDays: 0 },
      ],
      workingCalendar: { weekend: [], holidays: [] },
    });
    expect(s.canComputeCompletionDate).toBe(true);
    expect(s.completionDate).toBe('2026-10-22');
    expect(s.criticalPath).toEqual(['design', 'foundations', 'roof']);
    expect(s.baseline?.computedFinish).toBe('2026-10-22');
    const [project] = await dbs.owner.select().from(schema.projects).where(eq(schema.projects.id, projectId));
    expect(project!.forecastCompletionDate).toBe('2026-10-22');
    expect(project!.currentScheduleVersion).toBe(1);
    // Baselines are append-only in the database.
    await expect(
      dbs.owner.update(schema.scheduleBaselines).set({ reason: 'x' }).where(eq(schema.scheduleBaselines.projectId, projectId)),
    ).rejects.toThrow();
  });

  it('keeps inspector progress, customer acceptance and finance authorisation distinct', async () => {
    const m = await createMilestone(pm, projectId, { name: 'Foundations complete', plannedDate: '2026-10-20' });
    // Customer cannot record progress; inspector cannot accept.
    expect(await errorCode(recordMilestoneProgress(ownerA, m.id, { percentComplete: 50 }))).toMatch(/^forbidden/);
    expect(await errorCode(decideMilestone(inspector, m.id, { decision: 'accepted' }))).toMatch(/^forbidden/);
    const progressed = await recordMilestoneProgress(inspector, m.id, { percentComplete: 100 });
    expect(progressed.status).toBe('in_progress');
    expect(progressed.inspectorProgressPct).toBe(100);
    expect(progressed.customerAcceptedAt).toBeNull();
    // 100 % progress does not make it acceptable until staff submit it.
    expect(await errorCode(decideMilestone(ownerA, m.id, { decision: 'accepted' }))).toBe('invalid_transition');
    await submitMilestone(pm, m.id);
    // Finance cannot authorise before acceptance; members cannot accept.
    expect(await errorCode(authorizeMilestonePayment(finance, m.id, {}))).toBe('invalid_transition');
    expect(await errorCode(decideMilestone(memberA, m.id, { decision: 'accepted' }))).toMatch(/^forbidden/);
    const accepted = await decideMilestone(ownerA, m.id, { decision: 'accepted' });
    expect(accepted.status).toBe('accepted');
    expect(accepted.customerAcceptedBy).toBe(f.ownerA.id);
    expect(accepted.financeAuthorizedAt).toBeNull();
    // Finance needs MFA and the finance permission; the PM has neither.
    expect(await errorCode(authorizeMilestonePayment(staffIdentity(f.finance, 'finance', false), m.id, {}))).toBe('mfa_required');
    expect(await errorCode(authorizeMilestonePayment(pm, m.id, {}))).toMatch(/^forbidden/);
    const paid = await authorizeMilestonePayment(finance, m.id, {});
    expect(paid.financeAuthorizedBy).toBe(f.finance.id);
    expect(paid.status).toBe('accepted');
    expect(await errorCode(authorizeMilestonePayment(finance, m.id, {}))).toBe('invalid_transition');
  });

  let visitId: string;

  it('runs a site visit with offline-safe submission and evidence rules', async () => {
    const visit = await scheduleSiteVisit(pm, projectId, {
      inspectorUserId: f.inspector.id,
      scheduledAt: '2026-10-12T09:00:00.000Z',
      instructions: 'Check foundations',
    });
    visitId = visit.id;
    // Only the assigned inspector may start or submit.
    expect(await errorCode(startSiteVisit(staffIdentity(f.inspector2, 'inspector'), visitId, {}))).toBe('forbidden');
    expect(await errorCode(startSiteVisit(pm, visitId, {}))).toBe('forbidden');
    const started = await startSiteVisit(inspector, visitId, { startedAt: '2026-10-12T09:05:00.000Z' });
    expect(started.status).toBe('in_progress');
    const submission = {
      offlineClientId: 'device-1-visit-1',
      findingsMarkdown: '## Foundations\nRebar spacing as specified.',
      checklist: { rebar: 'ok', formwork: 'ok' },
      evidenceFileIds: [f.fileClean, f.fileScanning],
    };
    const first = await submitSiteVisit(inspector, visitId, submission);
    expect(first.status).toBe('submitted');
    expect(first.idempotentReplay).toBe(false);
    expect(first.evidence.find((e) => e.fileId === f.fileClean)?.outcome).toBe('created');
    expect(first.evidence.find((e) => e.fileId === f.fileScanning)?.outcome).toBe('rejected');
    // Connection dropped, the device resubmits: no duplicate, same visit.
    const replay = await submitSiteVisit(inspector, visitId, submission);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.evidence.find((e) => e.fileId === f.fileClean)?.outcome).toBe('replayed');
    expect(replay.evidenceCount).toBe(1);
    // A batch sync with the same offline id replays; another inspector's reuse is refused.
    const sync = await syncSiteVisits(inspector, { items: [{ ...submission, siteVisitId: visitId, evidenceFileIds: [f.fileClean] }] });
    expect(sync.results[0]!.outcome).toBe('replayed');
    const stolen = await syncSiteVisits(staffIdentity(f.inspector2, 'inspector'), { items: [{ ...submission, siteVisitId: visitId, evidenceFileIds: [] }] });
    expect(stolen.results[0]!.outcome).toBe('rejected');
    expect(stolen.results[0]!.code).toBe('conflict');
    const visits = await dbs.owner.select().from(schema.siteVisits).where(eq(schema.siteVisits.projectId, projectId));
    expect(visits).toHaveLength(1);
    // Evidence rules: quarantined and infected files are refused, receivedAt is server time, publication is restricted.
    expect(await errorCode(linkEvidence(inspector, projectId, { fileId: f.fileScanning }))).toBe('file_quarantined');
    expect(await errorCode(linkEvidence(inspector, projectId, { fileId: f.fileInfected }))).toBe('file_rejected');
    expect(await errorCode(linkEvidence(inspector, projectId, { fileId: f.fileOrgB }))).toMatch(/not_found|forbidden/);
    const ev = await linkEvidence(inspector, projectId, {
      fileId: f.fileClean2,
      siteVisitId: visitId,
      capturedAt: '2020-01-01T00:00:00.000Z',
      captureGps: { lon: 3.39, lat: 6.45 },
      offlineClientId: 'device-1-photo-2',
    });
    expect(ev.capturedAt).toBe('2020-01-01T00:00:00.000Z');
    expect(new Date(ev.receivedAt).getFullYear()).toBeGreaterThanOrEqual(2026);
    expect(ev.captureGps).toEqual({ lon: 3.39, lat: 6.45 });
    expect(ev.publication).toBe('restricted');
    expect((await linkEvidence(inspector, projectId, { fileId: f.fileClean2, offlineClientId: 'device-1-photo-2' })).idempotentReplay).toBe(true);
    expect(await errorCode(linkEvidence(pm, projectId, { fileId: f.fileClean2, offlineClientId: 'device-1-photo-2' }))).toBe('conflict');
    // Customers see nothing until staff approve; the uploader cannot approve their own upload.
    expect((await listEvidence(ownerA, projectId, { limit: 25 })).items).toHaveLength(0);
    expect(await errorCode(setEvidencePublication(inspector, projectId, ev.id, { publication: 'approved' }))).toMatch(/^forbidden/);
    await setEvidencePublication(pm, projectId, ev.id, { publication: 'approved' });
    const visible = await listEvidence(ownerA, projectId, { limit: 25 });
    expect(visible.items.map((e) => e.id)).toEqual([ev.id]);
    expect(JSON.stringify(visible)).not.toContain('storageKey');
  });

  it('reviews and releases a report through a different named professional, then the customer reads it', async () => {
    const report = await createReport(inspector, projectId, {
      kind: 'progress',
      title: 'Progress report 1',
      siteVisitId: visitId,
      initialRevision: { bodyMarkdown: 'Foundations complete.', scopeLimitations: 'Visual inspection only.', attachmentFileIds: [] },
    });
    expect(report.status).toBe('draft');
    expect(report.revisions[0]!.state).toBe('draft');
    // Nothing is visible to the customer before release.
    expect((await listReports(ownerA, projectId, { limit: 25 })).items).toHaveLength(0);
    expect(await errorCode(getReport(ownerA, report.id))).toBe('not_found');
    // The author cannot name themselves; the reviewer must hold review authority.
    expect(await errorCode(submitReport(inspector, report.id, { namedReviewerUserId: f.inspector.id, expectedVersion: 1 }))).toBe('validation_failed');
    expect(await errorCode(submitReport(inspector, report.id, { namedReviewerUserId: f.inspector2.id, expectedVersion: 1 }))).toBe('validation_failed');
    const inReview = await submitReport(inspector, report.id, { namedReviewerUserId: f.ops.id, expectedVersion: 1 });
    expect(inReview.status).toBe('in_review');
    expect(await errorCode(addReportRevision(inspector, report.id, { bodyMarkdown: 'edit', attachmentFileIds: [], expectedVersion: 2 }))).toBe('invalid_transition');
    const changes = await reviewReport(ops, report.id, { decision: 'changes_requested', note: 'Add rebar photos', expectedVersion: 2 });
    expect(changes.status).toBe('changes_requested');
    const revised = await addReportRevision(inspector, report.id, { bodyMarkdown: 'Foundations complete; photos attached.', attachmentFileIds: [f.fileClean], expectedVersion: 3 });
    expect(revised.currentVersion).toBe(2);
    await submitReport(inspector, report.id, { namedReviewerUserId: f.ops.id, expectedVersion: 4 });
    const approved = await reviewReport(ops, report.id, { decision: 'approved', expectedVersion: 5 });
    expect(approved.status).toBe('approved');
    expect(await errorCode(releaseReport(ops, report.id, { expectedVersion: 5 }))).toBe('version_conflict');
    const released = await releaseReport(ops, report.id, { expectedVersion: 6 });
    expect(released.status).toBe('released');
    expect(released.releasedVersion).toBe(2);
    expect(released.customerVisible).toBe(true);
    const customerView = await getReport(ownerA, report.id);
    expect(customerView.revisions.map((r) => r.version)).toEqual([2]);
    expect(customerView.revisions[0]!.state).toBe('released');
    expect(customerView.availableTransitions).toEqual([]);
    expect((await listReports(ownerA, projectId, { limit: 25 })).items.map((r) => r.id)).toEqual([report.id]);
    // Further edits start a new draft version; the released revision stays frozen and visible.
    const draft3 = await addReportRevision(inspector, report.id, { bodyMarkdown: 'Version 3 draft', attachmentFileIds: [], expectedVersion: 7 });
    expect(draft3.status).toBe('draft');
    expect(draft3.currentVersion).toBe(3);
    expect(draft3.releasedVersion).toBe(2);
    expect(draft3.revisions.find((r) => r.version === 2)?.state).toBe('released');
    expect(draft3.revisions.find((r) => r.version === 1)?.state).toBe('superseded');
    expect((await getReport(ownerA, report.id)).revisions.map((r) => r.version)).toEqual([2]);
    const outbox = await dbs.owner.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, 'project.report.released'));
    expect(outbox.some((o) => o.aggregateId === report.id)).toBe(true);
  });

  it('numbers defects per project and requires an independent verifier', async () => {
    const d1 = await createDefect(inspector, projectId, { title: 'Honeycombing in column C2', severity: 'major', accountableParty: 'contractor' });
    const d2 = await createDefect(pm, projectId, { title: 'Missing damp-proof course', severity: 'critical', accountableParty: 'contractor' });
    expect([d1.number, d2.number]).toEqual([1, 2]);
    await transitionDefect(pm, d1.id, { to: 'acknowledged' });
    await transitionDefect(pm, d1.id, { to: 'in_progress' });
    const resolved = await transitionDefect(pm, d1.id, { to: 'resolved' });
    expect(resolved.resolvedAt).not.toBeNull();
    expect(await errorCode(transitionDefect(pm, d1.id, { to: 'verified' }))).toBe('forbidden');
    expect(await errorCode(transitionDefect(inspector, d1.id, { to: 'verified' }))).toMatch(/^forbidden/);
    const verified = await transitionDefect(ops, d1.id, { to: 'verified' });
    expect(verified.verifiedBy).toBe(f.ops.id);
    // The customer can dispute with a reason but cannot verify.
    expect(await errorCode(transitionDefect(ownerA, d2.id, { to: 'verified' }))).toMatch(/^forbidden/);
    const issues = await getUnresolvedIssues(ownerA, projectId);
    expect(issues.defects.map((d) => d.id)).toEqual([d2.id]);
    const overview = await getProjectOverview(ownerA, projectId);
    expect(overview.defects.open).toBe(1);
    expect(overview.milestones.byStatus.accepted).toBe(1);
    expect(overview.latestReleasedReport?.releasedVersion).toBe(2);
    expect(overview.budget.variance.status).toBe('within_budget');
    expect(overview.schedule.forecastCompletionDate).toBe('2026-10-22');
    expect(overview.schedule.forecastSource).toBe('schedule_baseline');
    expect(overview.team.map((t) => t.userId)).toEqual(expect.arrayContaining([f.pm.id, f.inspector.id, f.ownerA.id]));
  });
});
