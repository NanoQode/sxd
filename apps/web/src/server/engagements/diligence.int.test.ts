import { and, desc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, schema } from '@simplexd/db';
import {
  acceptAssignment,
  activateAssignment,
  proposeAssignment,
} from '@/server/assignments/service';
import { getFile } from '@/server/files/queries';
import {
  addReportRevision,
  getReport,
  releaseReport,
  reviewReport,
  submitReport,
} from '@/server/projects/reports';
import {
  attachEngagementItemEvidence,
  createEngagementItem,
  getEngagementItem,
  listEngagementItems,
  listMyEngagementItems,
  respondToEngagementItem,
  transitionEngagementItem,
  updateEngagementItem,
} from './items';
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
 * Acceptance scenario 3 (brief §21), the engagement half: a customer's
 * diligence request gets a checklist, survey reference, red flag and query;
 * the assigned surveyor works only their item; the customer answers and
 * uploads; the decision memorandum is drafted from the active template,
 * reviewed by a different named professional, released, read and exported
 * by the customer; another organisation's customer is denied every id.
 * (Quote acceptance and sandbox payment are covered by the finance suites.)
 */

let f: EngagementFixture;
let templateId: string;
const templateIds: string[] = [];

beforeAll(async () => {
  f = await createEngagementFixture();
  templateId = await insertTemplate(
    f.dbs.owner,
    'diligence_memo',
    f.suffix,
    [
      { key: 'summary', heading: 'Summary of findings', guidance: 'Two paragraphs.', required: true },
      { key: 'title', heading: 'Title and documents', required: true },
      { key: 'survey', heading: 'Survey and boundaries', required: false },
      { key: 'recommendation', heading: 'Recommendation', required: true },
    ],
    'Desk review of documents supplied by the seller and one site visit. No court or government search fees were incurred.',
  );
  templateIds.push(templateId);
});

afterAll(async () => {
  await cleanupFixture(f, templateIds);
  await closeDb();
  await f.dbs.close();
});

describe('due diligence journey (scenario 3)', () => {
  it('runs checklist → partner work → customer answers → memo from template → review → release → export, with cross-organisation denial', async () => {
    const ops = staff(f.ops, 'operations_manager');
    const pm = staff(f.pm, 'project_manager');
    const otherPm = staff(f.otherPm, 'project_manager');
    const ownerA = customer(f, 'A');
    const adviserA = customer(f, 'adviserA');
    const ownerB = customer(f, 'B');
    const surveyor = partner(f.surveyor);
    const legal = partner(f.legal);
    const outsider = partner(f.outsider);

    // --- Legal and surveyor partners are assigned through the existing assignment flow.
    const surveyorAssignment = await proposeAssignment(ops, {
      serviceRequestId: f.requestA,
      assigneeUserId: f.surveyor,
      role: 'surveyor',
    });
    await acceptAssignment(surveyor, surveyorAssignment.id);
    await activateAssignment(ops, surveyorAssignment.id);
    const legalAssignment = await proposeAssignment(ops, {
      serviceRequestId: f.requestA,
      assigneeUserId: f.legal,
      role: 'legal',
    });
    await acceptAssignment(legal, legalAssignment.id);

    // --- Staff who manage the request add the records; validation is per kind.
    await expect(
      createEngagementItem(ownerA, f.requestA, { kind: 'query', title: 'Not allowed' }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    await expect(
      createEngagementItem(otherPm, f.requestA, { kind: 'query', title: 'Unassigned PM' }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    await expect(
      createEngagementItem(pm, f.requestA, { kind: 'red_flag', title: 'No severity' }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'validation_failed');
    await expect(
      createEngagementItem(pm, f.requestA, {
        kind: 'survey_reference',
        title: 'Assigned to a stranger',
        assigneeUserId: f.outsider,
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'validation_failed');

    const docCheck = await createEngagementItem(pm, f.requestA, {
      kind: 'document_check',
      title: 'Certificate of Occupancy',
      detail: 'Upload the C of O so the registry search can be matched.',
    });
    expect(docCheck).toMatchObject({ status: 'open', visibility: 'customer', version: 1 });
    const surveyRef = await createEngagementItem(pm, f.requestA, {
      kind: 'survey_reference',
      title: 'Survey plan verification',
      visibility: 'partner',
      assigneeUserId: f.surveyor,
    });
    expect(surveyRef.assigneeUserId).toBe(f.surveyor);
    const internalFinding = await createEngagementItem(pm, f.requestA, {
      kind: 'site_finding',
      title: 'Neighbour dispute rumour (unverified)',
      severity: 'medium',
      visibility: 'internal',
    });
    const redFlag = await createEngagementItem(pm, f.requestA, {
      kind: 'red_flag',
      title: 'Seller name differs from title holder',
      severity: 'high',
      detail: 'The deed names a company; the seller is an individual.',
    });
    const query = await createEngagementItem(pm, f.requestA, {
      kind: 'query',
      title: 'Who is the current occupier of the plot?',
    });
    // Request B belongs to another organisation.
    const itemB = await createEngagementItem(otherPm, f.requestB, {
      kind: 'document_check',
      title: 'Deed of assignment',
    });

    // Outbox: the surveyor was told about the assignment, the customer about the query and red flag.
    const events = await f.dbs.owner
      .select({ type: schema.outboxEvents.eventType, payload: schema.outboxEvents.payload })
      .from(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.aggregateType, 'engagement_item'),
          inArray(schema.outboxEvents.aggregateId, [surveyRef.id, redFlag.id, query.id, docCheck.id]),
        ),
      );
    expect(events.map((e) => e.type).sort()).toEqual([
      'engagement_item.assigned',
      'engagement_item.customer_action',
      'engagement_item.customer_action',
    ]);
    expect(
      events.find((e) => e.type === 'engagement_item.assigned')?.payload,
    ).toMatchObject({ recipientUserIds: [f.surveyor] });

    // --- The surveyor sees and works only what is theirs.
    const mine = await listMyEngagementItems(surveyor, {});
    expect(mine.items.map((i) => i.id)).toEqual([surveyRef.id]);
    expect(mine.items[0]!.serviceRequestReference).toBe(`SR-DD-A-${f.suffix}`);
    const onRequest = await listEngagementItems(surveyor, f.requestA);
    expect(onRequest.items.map((i) => i.id).sort()).toEqual([surveyRef.id].sort());
    await expect(getEngagementItem(surveyor, internalFinding.id)).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
    await expect(getEngagementItem(surveyor, redFlag.id)).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
    await expect(getEngagementItem(surveyor, itemB.id)).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
    await expect(listEngagementItems(surveyor, f.requestB)).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
    await expect(getEngagementWorkspace(surveyor, f.requestB)).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
    // The legal partner (accepted, not the assignee) reads partner-visible items but cannot change them.
    const legalView = await getEngagementItem(legal, surveyRef.id);
    expect(legalView.can).toEqual({
      editableFields: [],
      transitions: [],
      attachEvidence: false,
      respond: false,
    });
    await expect(
      transitionEngagementItem(legal, surveyRef.id, { to: 'in_progress', expectedVersion: 1 }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    // A partner with no assignment sees nothing.
    await expect(getEngagementItem(outsider, surveyRef.id)).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );

    // The surveyor may update detail/reference/severity, not the title or visibility.
    await expect(
      updateEngagementItem(surveyor, surveyRef.id, { title: 'Renamed', expectedVersion: 1 }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    await expect(
      transitionEngagementItem(surveyor, surveyRef.id, { to: 'satisfied', expectedVersion: 1 }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'invalid_transition'); // reference required
    const withRef = await updateEngagementItem(surveyor, surveyRef.id, {
      reference: 'LS/D/1234/2019',
      detail: 'Beacons match the plan; the north boundary overlaps a road setback.',
      expectedVersion: 1,
    });
    expect(withRef).toMatchObject({ reference: 'LS/D/1234/2019', version: 2 });
    // Stale version is refused.
    await expect(
      transitionEngagementItem(surveyor, surveyRef.id, { to: 'in_progress', expectedVersion: 1 }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'version_conflict');
    // Evidence: only their own uploads; the legal partner's file is refused.
    const surveyorFile = await insertCleanFile(f, {
      ownerUserId: f.surveyor,
      organizationId: f.orgA,
      name: 'beacon-photos.pdf',
      entity: { type: 'service_request', id: f.requestA },
    });
    const legalFile = await insertCleanFile(f, {
      ownerUserId: f.legal,
      organizationId: f.orgA,
      name: 'legal-opinion.pdf',
      entity: { type: 'service_request', id: f.requestA },
    });
    await expect(
      attachEngagementItemEvidence(surveyor, surveyRef.id, {
        fileIds: [legalFile],
        expectedVersion: 2,
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'validation_failed');
    const withEvidence = await attachEngagementItemEvidence(surveyor, surveyRef.id, {
      fileIds: [surveyorFile],
      caption: 'Beacon photographs',
      expectedVersion: 2,
    });
    expect(withEvidence.evidence.map((e) => e.originalName)).toEqual(['beacon-photos.pdf']);
    expect(withEvidence.evidence[0]!.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    // Partner-only item: the customer organisation does not get the file.
    const [surveyorFileRow] = await f.dbs.owner
      .select({ organizationId: schema.fileObjects.organizationId })
      .from(schema.fileObjects)
      .where(eq(schema.fileObjects.id, surveyorFile));
    expect(surveyorFileRow!.organizationId).toBeNull();
    await expect(
      transitionEngagementItem(surveyor, surveyRef.id, {
        to: 'waived',
        reason: 'not needed',
        expectedVersion: 3,
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    const satisfiedSurvey = await transitionEngagementItem(surveyor, surveyRef.id, {
      to: 'satisfied',
      resolutionNote: 'Plan verified at the Surveyor-General office.',
      expectedVersion: 3,
    });
    expect(satisfiedSurvey).toMatchObject({
      status: 'satisfied',
      resolutionNote: 'Plan verified at the Surveyor-General office.',
      version: 4,
    });
    expect(satisfiedSurvey.resolvedAt).not.toBeNull();

    // --- The customer sees customer-visible records only and answers the query.
    const wsA = await getEngagementWorkspace(ownerA, f.requestA);
    expect(wsA.viewer).toBe('customer');
    expect(wsA.items.map((i) => i.id).sort()).toEqual([docCheck.id, redFlag.id, query.id].sort());
    expect(wsA.summary).toMatchObject({
      redFlags: { open: 1, total: 1, highestOpenSeverity: 'high' },
      openCustomerQueries: 1,
      openDocumentRequests: 1,
    });
    expect(wsA.reports).toEqual([]);
    expect(wsA.canManageItems).toBe(false);
    const queryView = wsA.items.find((i) => i.id === query.id)!;
    expect(queryView.can.respond).toBe(true);
    expect(queryView.can.transitions).toEqual([]);
    await expect(
      transitionEngagementItem(ownerA, query.id, { to: 'satisfied', expectedVersion: 1 }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    await expect(getEngagementItem(ownerA, internalFinding.id)).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
    const answered = await respondToEngagementItem(ownerA, query.id, {
      body: 'A caretaker lives there; the seller says he leaves on completion.',
      expectedVersion: 1,
    });
    expect(answered.status).toBe('in_progress');
    expect(answered.responses).toHaveLength(1);
    expect(answered.responses[0]).toMatchObject({ authorUserId: f.ownerA, authorRole: 'customer' });
    // An adviser may comment; a red flag is not answerable; the other organisation sees nothing.
    const adviserReply = await respondToEngagementItem(adviserA, query.id, {
      body: 'Please also ask for the caretaker agreement.',
      expectedVersion: 2,
    });
    expect(adviserReply.responses).toHaveLength(2);
    await expect(
      respondToEngagementItem(ownerA, redFlag.id, { body: 'x', expectedVersion: 1 }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    await expect(
      respondToEngagementItem(ownerB, query.id, { body: 'x', expectedVersion: 3 }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    // The customer uploads the requested document against the checklist item.
    const cofo = await insertCleanFile(f, {
      ownerUserId: f.ownerA,
      organizationId: f.orgA,
      purpose: 'org_document',
      name: 'c-of-o.pdf',
      entity: { type: 'service_request', id: f.requestA },
    });
    await expect(
      attachEngagementItemEvidence(ownerA, redFlag.id, { fileIds: [cofo], expectedVersion: 1 }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    const docProvided = await attachEngagementItemEvidence(ownerA, docCheck.id, {
      fileIds: [cofo],
      expectedVersion: 1,
    });
    expect(docProvided.status).toBe('in_progress');
    expect(docProvided.evidence.map((e) => e.originalName)).toEqual(['c-of-o.pdf']);
    // Staff were told the customer acted.
    const customerInputEvents = await f.dbs.owner
      .select({ type: schema.outboxEvents.eventType })
      .from(schema.outboxEvents)
      .where(
        and(
          inArray(schema.outboxEvents.eventType, [
            'engagement_item.responded',
            'engagement_item.evidence_attached',
          ]),
          inArray(schema.outboxEvents.aggregateId, [query.id, docCheck.id]),
        ),
      );
    expect(customerInputEvents.length).toBeGreaterThanOrEqual(2);

    // --- Staff close the records: the document check needs its evidence; failures need a reason.
    const docSatisfied = await transitionEngagementItem(pm, docCheck.id, {
      to: 'satisfied',
      resolutionNote: 'Matches registry search no. 44/2026.',
      expectedVersion: 2,
    });
    expect(docSatisfied.status).toBe('satisfied');
    await expect(
      transitionEngagementItem(pm, redFlag.id, { to: 'failed', expectedVersion: 1 }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'invalid_transition');
    const querySatisfied = await transitionEngagementItem(pm, query.id, {
      to: 'satisfied',
      expectedVersion: 3,
    });
    expect(querySatisfied.responses).toHaveLength(2);
    // The staff view of the internal finding stays staff-only; the PM manages everything.
    const staffWs = await getEngagementWorkspace(pm, f.requestA);
    expect(staffWs.items).toHaveLength(5);
    expect(staffWs.canManageItems).toBe(true);
    expect(staffWs.canDraftReports).toBe(true);

    // --- Decision memorandum under the request, prefilled from the active template.
    await expect(
      createServiceRequestReport(ownerA, f.requestA, { kind: 'diligence_memo', title: 'Nope', referenceItems: true }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    await expect(
      createServiceRequestReport(ops, f.requestA, { kind: 'diligence_memo', title: 'Nope', referenceItems: true }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden'); // operations managers do not draft
    const memo = await createServiceRequestReport(pm, f.requestA, {
      kind: 'diligence_memo',
      title: 'Plot 12 decision memorandum',
      templateId,
      referenceItems: true,
    });
    expect(memo).toMatchObject({
      projectId: null,
      serviceRequestId: f.requestA,
      kind: 'diligence_memo',
      status: 'draft',
      currentVersion: 1,
      customerVisible: false,
    });
    expect(memo.template.id).toBe(templateId);
    expect(memo.template.sections.map((s) => s.guidance)).toContain('Two paragraphs.');
    const draft = memo.revisions[0]!;
    expect(draft.bodyMarkdown).toContain('## Summary of findings');
    expect(draft.bodyMarkdown).toContain('## Recommendation');
    expect(draft.bodyMarkdown).not.toMatch(/guidance|two paragraphs/i);
    expect(draft.scopeLimitations).toContain('Desk review of documents');
    const findings = draft.findings as {
      template: { id: string; sections: Array<{ key: string }> };
      engagementItems: { items: Array<{ id: string; kind: string; evidence: Array<{ name: string }> }> };
    };
    expect(findings.template.id).toBe(templateId);
    expect(findings.template.sections.map((s) => s.key)).toEqual([
      'summary',
      'title',
      'survey',
      'recommendation',
    ]);
    const snapshotIds = findings.engagementItems.items.map((i) => i.id).sort();
    expect(snapshotIds).toEqual([docCheck.id, redFlag.id, query.id].sort());
    expect(snapshotIds).not.toContain(internalFinding.id);
    expect(
      findings.engagementItems.items.find((i) => i.id === docCheck.id)!.evidence.map((e) => e.name),
    ).toEqual(['c-of-o.pdf']);

    // The skeleton cannot be submitted: required sections are empty.
    await expect(
      submitReport(pm, memo.id, { namedReviewerUserId: f.ops, expectedVersion: 1 }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'validation_failed');
    // Guarantee wording is refused for a memorandum.
    const withGuarantee = await addReportRevision(pm, memo.id, {
      bodyMarkdown: [
        '## Summary of findings',
        'We guarantee the title is clean.',
        '## Title and documents',
        'C of O matched.',
        '## Recommendation',
        'Proceed.',
      ].join('\n'),
      attachmentFileIds: [],
      scopeLimitations: draft.scopeLimitations,
      expectedVersion: 1,
    });
    expect(withGuarantee.currentVersion).toBe(2);
    await expect(
      submitReport(pm, memo.id, { namedReviewerUserId: f.ops, expectedVersion: 2 }),
    ).rejects.toSatisfy(
      (e) => errorCode(e) === 'validation_failed' && /guarantee/i.test((e as Error).message),
    );
    const finalDraft = await addReportRevision(pm, memo.id, {
      summary: 'Proceed only after the seller supplies the company resolution.',
      bodyMarkdown: [
        '## Summary of findings',
        'The title chain is consistent except for the seller identity mismatch recorded as a red flag.',
        '## Title and documents',
        'Certificate of Occupancy matched registry search no. 44/2026.',
        '## Survey and boundaries',
        'Survey plan LS/D/1234/2019 verified; note the road setback overlap.',
        '## Recommendation',
        'Proceed once the company resolution authorising the sale is produced. This memorandum is not a guarantee of title.',
      ].join('\n'),
      attachmentFileIds: [legalFile],
      scopeLimitations: draft.scopeLimitations,
      expectedVersion: 2,
    });
    expect(finalDraft.currentVersion).toBe(3);
    // Each revision re-captures the item snapshot server-side.
    const rev3 = finalDraft.revisions.find((r) => r.version === 3)!;
    const rev3Findings = rev3.findings as { engagementItems: { items: Array<{ status: string; id: string }> } };
    expect(rev3Findings.engagementItems.items.find((i) => i.id === query.id)!.status).toBe('satisfied');

    // A named professional reviewer who is not the author; the author can neither review nor release.
    await expect(
      submitReport(pm, memo.id, { namedReviewerUserId: f.pm, expectedVersion: 3 }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'validation_failed');
    const inReview = await submitReport(pm, memo.id, {
      namedReviewerUserId: f.ops,
      expectedVersion: 3,
    });
    expect(inReview).toMatchObject({ status: 'in_review', namedReviewerUserId: f.ops });
    await expect(
      reviewReport(pm, memo.id, { decision: 'approved', expectedVersion: 4 }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    const approved = await reviewReport(ops, memo.id, { decision: 'approved', expectedVersion: 4 });
    expect(approved.status).toBe('approved');
    await expect(releaseReport(pm, memo.id, { expectedVersion: 5 })).rejects.toSatisfy(
      (e) => errorCode(e) === 'forbidden',
    );
    // Not released yet: the customer cannot see it and the export is refused.
    await expect(getReport(ownerA, memo.id)).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    await expect(exportReleasedReport(ops, memo.id)).rejects.toSatisfy(
      (e) => errorCode(e) === 'invalid_transition',
    );
    const released = await releaseReport(ops, memo.id, { expectedVersion: 5 });
    expect(released).toMatchObject({
      status: 'released',
      releasedVersion: 3,
      customerVisible: true,
      namedReviewerName: `Name ${f.ops}`,
    });

    // --- The customer reads the released revision and exports it.
    const customerView = await getReport(ownerA, memo.id);
    expect(customerView.revisions.map((r) => r.version)).toEqual([3]);
    expect(customerView.availableTransitions).toEqual([]);
    const wsAfter = await getEngagementWorkspace(ownerA, f.requestA);
    expect(wsAfter.reports.map((r) => r.id)).toEqual([memo.id]);
    const exported = await exportReleasedReport(ownerA, memo.id, {
      now: new Date('2026-09-23T10:00:00Z'),
    });
    expect(exported.version).toBe(3);
    expect(exported.filename).toBe('plot-12-decision-memorandum-v3.html');
    const html = exported.html;
    expect(html).toContain('Plot 12 decision memorandum');
    expect(html).toContain('Released version 3');
    expect(html).toContain(`Name ${f.ops}`); // named reviewer
    expect(html).toContain(`Name ${f.pm}`); // author
    expect(html).toContain('Desk review of documents'); // scope and limitations
    expect(html).toContain('Certificate of Occupancy matched registry search'); // body section
    expect(html).toContain('Seller name differs from title holder'); // red flag summary
    expect(html).not.toContain('Neighbour dispute rumour'); // internal item never exported
    expect(html).toContain('c-of-o.pdf'); // evidence reference by name...
    const [cofoRow] = await f.dbs.owner
      .select({ checksum: schema.fileObjects.checksumSha256 })
      .from(schema.fileObjects)
      .where(eq(schema.fileObjects.id, cofo));
    expect(html).toContain(cofoRow!.checksum!); // ...and checksum
    expect(html).toContain('legal-opinion.pdf'); // attachment listed
    expect(html).not.toMatch(/\/api\/v1\/files\/[0-9a-f-]+\/download/); // never a signed link
    expect(html).toContain('Released report version 3 — generated 23 September 2026');
    expect(html).toContain('Save as PDF');
    const [exportAudit] = await f.dbs.owner
      .select()
      .from(schema.auditEvents)
      .where(
        and(eq(schema.auditEvents.action, 'report.exported'), eq(schema.auditEvents.entityId, memo.id)),
      )
      .orderBy(desc(schema.auditEvents.createdAt));
    expect(exportAudit).toMatchObject({ actorUserId: f.ownerA, organizationId: f.orgA });
    const releaseEvents = await f.dbs.owner
      .select({ payload: schema.outboxEvents.payload })
      .from(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.eventType, 'project.report.released'),
          eq(schema.outboxEvents.aggregateId, memo.id),
        ),
      );
    expect(releaseEvents[0]?.payload).toMatchObject({
      serviceRequestId: f.requestA,
      customerContactUserId: f.ownerA,
    });

    // --- Another organisation's customer is denied every id.
    await expect(getEngagementWorkspace(ownerB, f.requestA)).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
    await expect(listEngagementItems(ownerB, f.requestA)).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
    for (const id of [docCheck.id, redFlag.id, query.id, surveyRef.id]) {
      await expect(getEngagementItem(ownerB, id)).rejects.toSatisfy(
        (e) => errorCode(e) === 'not_found',
      );
    }
    await expect(getReport(ownerB, memo.id)).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    await expect(exportReleasedReport(ownerB, memo.id)).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
    for (const fileId of [cofo, legalFile, surveyorFile]) {
      await expect(getFile(ownerB, fileId)).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    }
    // The surveyor partner never sees the memorandum either.
    await expect(getReport(surveyor, memo.id)).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
  });
});
