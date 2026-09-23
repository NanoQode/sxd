import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, schema } from '@simplexd/db';
import { acceptAssignment, proposeAssignment } from '@/server/assignments/service';
import { addReportRevision, getReport, releaseReport, reviewReport, submitReport } from '@/server/projects/reports';
import { attachEngagementItemEvidence, createEngagementItem, listMyEngagementItems } from './items';
import { createServiceRequestReport, exportReleasedReport } from './reports';
import { getEngagementWorkspace } from './workspace';
import {
  cleanupFixture,
  createEngagementFixture,
  customer,
  errorCode,
  insertCleanFile,
  insertTemplate,
  partner,
  staff,
  type EngagementFixture,
} from './testing/fixtures';

/**
 * Virtual inspection (brief §8): appointment with an optional live meeting
 * link, a checklist of site findings with severity and photo evidence
 * recorded by the assigned inspector, and a reviewed inspection report the
 * customer can read and export.
 */

let f: EngagementFixture;
const templateIds: string[] = [];

beforeAll(async () => {
  f = await createEngagementFixture();
  templateIds.push(
    await insertTemplate(
      f.dbs.owner,
      'virtual_inspection',
      f.suffix,
      [
        { key: 'summary', heading: 'Summary', required: true },
        { key: 'checklist', heading: 'Checklist results', required: true },
        { key: 'findings', heading: 'Findings and severity', required: true },
      ],
      'Remote inspection over a live video call guided by the occupier; areas not shown on camera were not inspected.',
    ),
  );
});

afterAll(async () => {
  await cleanupFixture(f, templateIds);
  await closeDb();
  await f.dbs.close();
});

describe('virtual inspection', () => {
  it('records findings with severity, shows the live meeting link to participants and exports the reviewed report', async () => {
    const ops = staff(f.ops, 'operations_manager');
    const inspector = staff(f.inspector, 'inspector');
    const ownerA = customer(f, 'A');
    const ownerB = customer(f, 'B');
    const surveyor = partner(f.surveyor);

    // An inspector who is not attached to the request cannot record findings on it.
    await expect(
      createEngagementItem(inspector, f.inspectionRequest, {
        kind: 'site_finding',
        title: 'Not yet assigned',
        severity: 'low',
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    const assignment = await proposeAssignment(ops, {
      serviceRequestId: f.inspectionRequest,
      assigneeUserId: f.inspector,
      role: 'inspector',
    });
    await acceptAssignment(inspector, assignment.id);

    // Live meeting: the link is exposed only while the conference is ready and the appointment active.
    const starts = new Date(Date.now() + 86_400_000);
    const [appointment] = await f.dbs.owner
      .insert(schema.appointments)
      .values({
        organizationId: f.orgA,
        kind: 'virtual_inspection',
        status: 'confirmed',
        staffUserId: f.inspector,
        customerUserId: f.ownerA,
        startsAt: starts,
        endsAt: new Date(starts.getTime() + 45 * 60_000),
        topic: 'Duplex walkthrough',
        meetingProvider: 'google_meet',
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        conferenceStatus: 'ready',
        serviceRequestId: f.inspectionRequest,
        icsToken: randomUUID(),
      })
      .returning({ id: schema.appointments.id });

    // Checklist and annotated findings: severity is mandatory for site findings.
    await expect(
      createEngagementItem(inspector, f.inspectionRequest, { kind: 'site_finding', title: 'Roof' }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'validation_failed');
    const roof = await createEngagementItem(inspector, f.inspectionRequest, {
      kind: 'site_finding',
      title: 'Roof: no visible leaks',
      severity: 'info',
      reference: 'Roof / all rooms',
      assigneeUserId: f.inspector,
    });
    const damp = await createEngagementItem(inspector, f.inspectionRequest, {
      kind: 'site_finding',
      title: 'Damp patch on kitchen ceiling',
      severity: 'high',
      detail: 'Approximately 60 cm wide, directly below the upstairs bathroom.',
      reference: 'Kitchen, north wall',
      assigneeUserId: f.inspector,
    });
    const photo = await insertCleanFile(f, {
      ownerUserId: f.inspector,
      organizationId: f.orgA,
      name: 'kitchen-ceiling.jpg',
      mime: 'image/jpeg',
      entity: { type: 'service_request', id: f.inspectionRequest },
    });
    const dampWithPhoto = await attachEngagementItemEvidence(inspector, damp.id, {
      fileIds: [photo],
      caption: 'Damp patch, kitchen ceiling',
      capturedAt: new Date('2026-09-20T09:30:00Z').toISOString(),
      expectedVersion: 1,
    });
    expect(dampWithPhoto.evidence.map((e) => e.originalName)).toEqual(['kitchen-ceiling.jpg']);
    const [evidenceRow] = await f.dbs.owner
      .select()
      .from(schema.evidence)
      .where(eq(schema.evidence.fileId, photo));
    expect(evidenceRow).toMatchObject({ kind: 'photo', uploaderUserId: f.inspector });
    expect(evidenceRow!.capturedAt?.toISOString()).toBe('2026-09-20T09:30:00.000Z');
    expect((await listMyEngagementItems(inspector, {})).items.map((i) => i.id).sort()).toEqual(
      [roof.id, damp.id].sort(),
    );

    // Workspace: the customer sees findings and the meeting link; an unrelated partner sees nothing.
    const wsCustomer = await getEngagementWorkspace(ownerA, f.inspectionRequest);
    expect(wsCustomer.workflowTemplateKey).toBe('virtual_inspection');
    expect(wsCustomer.items.map((i) => i.title).sort()).toEqual(
      ['Damp patch on kitchen ceiling', 'Roof: no visible leaks'].sort(),
    );
    expect(wsCustomer.appointments).toHaveLength(1);
    expect(wsCustomer.appointments[0]).toMatchObject({
      id: appointment!.id,
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
      conferenceStatus: 'ready',
    });
    await expect(getEngagementWorkspace(surveyor, f.inspectionRequest)).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
    // Once the appointment is completed the link is no longer exposed.
    await f.dbs.owner
      .update(schema.appointments)
      .set({ status: 'completed' })
      .where(eq(schema.appointments.id, appointment!.id));
    expect(
      (await getEngagementWorkspace(ownerA, f.inspectionRequest)).appointments[0]!.meetingUrl,
    ).toBeNull();

    // Reviewed inspection report: the inspector drafts, the operations manager reviews and releases.
    const report = await createServiceRequestReport(inspector, f.inspectionRequest, {
      kind: 'virtual_inspection',
      title: 'Duplex virtual inspection report',
      templateId: templateIds[0],
      referenceItems: true,
    });
    expect(report.revisions[0]!.scopeLimitations).toContain('Remote inspection');
    const filled = await addReportRevision(inspector, report.id, {
      bodyMarkdown: [
        '## Summary',
        'Generally sound; one high-severity damp finding needs a plumber before completion.',
        '## Checklist results',
        'Roof, walls and floors were shown on camera; the loft was not accessible.',
        '## Findings and severity',
        'See the findings table.',
      ].join('\n'),
      attachmentFileIds: [],
      scopeLimitations: report.revisions[0]!.scopeLimitations,
      expectedVersion: 1,
    });
    // Submitting without a scope statement is refused for inspection reports.
    const noScope = await addReportRevision(inspector, report.id, {
      bodyMarkdown: filled.revisions.find((r) => r.version === 2)!.bodyMarkdown,
      attachmentFileIds: [],
      scopeLimitations: null,
      expectedVersion: 2,
    });
    await expect(
      submitReport(inspector, report.id, { namedReviewerUserId: f.ops, expectedVersion: 3 }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'validation_failed');
    const restored = await addReportRevision(inspector, report.id, {
      bodyMarkdown: noScope.revisions.find((r) => r.version === 3)!.bodyMarkdown,
      attachmentFileIds: [],
      scopeLimitations: report.revisions[0]!.scopeLimitations,
      expectedVersion: 3,
    });
    await submitReport(inspector, report.id, { namedReviewerUserId: f.ops, expectedVersion: 4 });
    await expect(
      reviewReport(inspector, report.id, { decision: 'approved', expectedVersion: 5 }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    await reviewReport(ops, report.id, { decision: 'approved', expectedVersion: 5 });
    const released = await releaseReport(ops, report.id, { expectedVersion: 6 });
    expect(released.releasedVersion).toBe(restored.currentVersion);

    const view = await getReport(ownerA, report.id);
    expect(view.revisions).toHaveLength(1);
    const exported = await exportReleasedReport(ownerA, report.id);
    expect(exported.html).toContain('Virtual inspection report');
    expect(exported.html).toContain('Damp patch on kitchen ceiling');
    expect(exported.html).toContain('High'); // severity label
    expect(exported.html).toContain('kitchen-ceiling.jpg');
    expect(exported.html).toContain('Remote inspection over a live video call');
    expect(exported.html).toContain(`Released report version ${released.releasedVersion}`);
    await expect(exportReleasedReport(ownerB, report.id)).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
    await expect(getReport(surveyor, report.id)).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
  });
});
