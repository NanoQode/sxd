import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, schema } from '@simplexd/db';
import { connectTestDatabases, resetDatabase, type TestDatabases } from '@simplexd/db/testing';
import { decideAward, getAward, listMyAwards, publishAward, respondToAward } from './awards';
import { addBidRevision, createBid, getBid, listMyBids, listTenderBids, openTenderBids, submitBid, withdrawBid } from './bids';
import { getTenderComparison, scoreBid, startEvaluation } from './evaluation';
import { answerTenderQuestion, askTenderQuestion, listTenderQuestions } from './questions';
import { closeTender, createTender, getTender, inviteTenderPartners, listMyInvitedTenders, listTenders, publishTender, reviseTender } from './tenders';
import {
  customerIdentity,
  enableCommercialFlags,
  hoursFromNow,
  insertOrganization,
  insertPartner,
  insertStaff,
  partnerIdentity,
  staffIdentity,
} from './test-fixtures';

/**
 * Acceptance scenario 4: a contractor submits a bid before closing, cannot
 * revise after closing, cannot see a competitor's submission and receives the
 * award decision only when published. Plus the sealed-bid rule for staff.
 */

let dbs: TestDatabases;
const admin = staffIdentity('tnd-admin', ['super_admin']);
const adminNoMfa = staffIdentity('tnd-admin', ['super_admin'], { mfaVerified: false });
const opsManager = staffIdentity('tnd-ops', ['operations_manager']);
const contractorA = partnerIdentity('tnd-contractor-a');
const contractorB = partnerIdentity('tnd-contractor-b');
const customerA = customerIdentity('tnd-customer-a', 'tnd-org-a');
const customerB = customerIdentity('tnd-customer-b', 'tnd-org-b');

beforeAll(async () => {
  dbs = connectTestDatabases();
  await resetDatabase(dbs.owner);
  await enableCommercialFlags(dbs.owner);
  await insertStaff(dbs.owner, 'tnd-admin', ['super_admin']);
  await insertStaff(dbs.owner, 'tnd-ops', ['operations_manager']);
  await insertPartner(dbs.owner, 'tnd-contractor-a');
  await insertPartner(dbs.owner, 'tnd-contractor-b');
  await insertOrganization(dbs.owner, 'tnd-org-a', [{ userId: 'tnd-customer-a', role: 'owner' }]);
  await insertOrganization(dbs.owner, 'tnd-org-b', [{ userId: 'tnd-customer-b', role: 'owner' }]);
});

afterAll(async () => {
  await closeDb();
  await dbs.close();
});

function tenderInput(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 'tnd-org-a',
    title: 'Two-storey duplex, Ibeju-Lekki',
    scopeFileIds: [],
    timeline: {
      releaseAt: hoursFromNow(-1),
      questionCutoffAt: hoursFromNow(0.5),
      submissionDeadlineAt: hoursFromNow(2),
      evaluationCompleteAt: hoursFromNow(48),
      awardTargetAt: hoursFromNow(72),
    },
    displayTimeZone: 'Africa/Lagos',
    evaluationWeights: { price: 60, quality: 40 },
    partnerDisclosure: 'SimplexD holds no interest in any invited contractor.',
    sealed: true,
    ...overrides,
  } as Parameters<typeof createTender>[1];
}

async function setDeadline(tenderId: string, when: Date): Promise<void> {
  await dbs.owner.update(schema.tenders).set({ submissionDeadlineAt: when }).where(eq(schema.tenders.id, tenderId));
}

describe('tender lifecycle and sealed bids (acceptance scenario 4)', () => {
  it('runs end to end with competitor isolation, sealing and award visibility', async () => {
    // Feature gate and permissions.
    await expect(createTender(staffIdentity('tnd-admin', ['super_admin'], { flags: {} }), tenderInput())).rejects.toMatchObject({ code: 'feature_disabled' });
    await expect(createTender(staffIdentity('tnd-ops', ['inspector']), tenderInput())).rejects.toMatchObject({ name: 'AuthorizationError' });
    await expect(createTender(admin, tenderInput({ evaluationWeights: { price: 50, quality: 40 } }))).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      createTender(admin, tenderInput({ timeline: { releaseAt: hoursFromNow(3), submissionDeadlineAt: hoursFromNow(2) } })),
    ).rejects.toMatchObject({ code: 'validation_failed' });

    const tender = await createTender(admin, tenderInput());
    expect(tender.reference).toMatch(/^TND-\d{4}-\d{4}$/);
    expect(tender.status).toBe('draft');
    expect(tender.timeline.display.submissionDeadlineAt).toMatch(/\(Africa\/Lagos\)$/);

    // Invitations need partner profiles; a customer is not one.
    await expect(inviteTenderPartners(admin, tender.id, { partnerUserIds: ['tnd-customer-a'] })).rejects.toMatchObject({ code: 'validation_failed' });
    const invitations = await inviteTenderPartners(admin, tender.id, { partnerUserIds: ['tnd-contractor-a', 'tnd-contractor-b'] });
    expect(invitations.map((i) => i.status)).toEqual(['invited', 'invited']);

    // Drafts are invisible to partners; published tenders are visible to invitees only.
    await expect(getTender(contractorA, tender.id)).rejects.toMatchObject({ code: 'not_found' });
    const published = await publishTender(admin, tender.id, { expectedVersion: tender.version });
    expect(published.status).toBe('published');
    const outbox = await dbs.owner.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, 'tender.published'));
    expect(outbox[0]?.payload).toMatchObject({ tenderId: tender.id, recipientUserIds: ['tnd-contractor-a', 'tnd-contractor-b'] });

    const seenByA = await getTender(contractorA, tender.id);
    expect(seenByA.myInvitation?.status).toBe('viewed');
    expect(seenByA.invitations).toHaveLength(1);
    expect(seenByA.partnerDisclosure).toContain('no interest');
    expect(seenByA.bidCount).toBeNull();
    await expect(getTender(partnerIdentity('tnd-contractor-c'), tender.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(getTender(customerB, tender.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await getTender(customerA, tender.id)).invitations).toHaveLength(2);
    expect((await listMyInvitedTenders(contractorA, { limit: 10 })).items.map((t) => t.id)).toEqual([tender.id]);
    expect((await listTenders(customerB, { limit: 10 })).items).toEqual([]);
    expect((await listTenders(customerA, { limit: 10 })).items.map((t) => t.id)).toEqual([tender.id]);

    // Questions: the asker sees their own; competitors only published, anonymised answers.
    const question = await askTenderQuestion(contractorA, tender.id, { question: 'Is the perimeter fence in scope?' });
    expect((await listTenderQuestions(contractorB, tender.id))).toEqual([]);
    const answered = await answerTenderQuestion(admin, tender.id, question.id, { answer: 'Yes, see drawing A-101.', publish: true });
    expect(answered.published).toBe(true);
    const forB = await listTenderQuestions(contractorB, tender.id);
    expect(forB).toHaveLength(1);
    expect(forB[0]).toMatchObject({ askedByUserId: null, askedByMe: false, answer: 'Yes, see drawing A-101.' });
    expect((await listTenderQuestions(contractorA, tender.id))[0]).toMatchObject({ askedByMe: true, askedByUserId: null });
    expect((await listTenderQuestions(admin, tender.id))[0]?.askedByUserId).toBe('tnd-contractor-a');

    // Revisions: a deadline can only move later.
    await expect(
      reviseTender(admin, tender.id, { changes: {}, deadlineExtendedTo: hoursFromNow(1), reason: 'shorten', expectedVersion: published.version }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const revised = await reviseTender(admin, tender.id, {
      changes: { title: 'Two-storey duplex, Ibeju-Lekki (addendum 1)' },
      addendumMarkdown: 'Fence added to scope.',
      deadlineExtendedTo: hoursFromNow(3),
      reason: 'Fence scope clarified',
      expectedVersion: published.version,
    });
    expect(revised.currentRevision).toBe(2);
    expect(revised.revisions).toHaveLength(1);
    expect(revised.revisions[0]?.deadlineExtendedTo).not.toBeNull();

    // Bids before the deadline.
    await expect(createBid(customerA, tender.id)).rejects.toMatchObject({ code: 'not_found' });
    const bidA = await createBid(contractorA, tender.id);
    expect(bidA.status).toBe('draft');
    expect((await createBid(contractorA, tender.id)).id).toBe(bidA.id);
    const withContent = await addBidRevision(contractorA, bidA.id, { amountKobo: '150000000000', currency: 'NGN', lineItems: [], qualifications: { cac: 'RC123' }, attachmentFileIds: [] });
    expect(withContent.latestRevision?.submittedAt).toBeNull();
    const submittedA = await submitBid(contractorA, bidA.id, { clientClaimedTime: '2000-01-01T00:00:00Z' });
    expect(submittedA.status).toBe('submitted');
    expect(submittedA.currentVersion).toBe(2);
    expect(submittedA.latestRevision?.submittedAt).not.toBeNull();
    const bidB = await createBid(contractorB, tender.id);
    const submittedB = await submitBid(contractorB, bidB.id, {
      revision: { amountKobo: '140000000000', currency: 'NGN', lineItems: [], durationDays: 300, qualifications: {}, attachmentFileIds: [] },
    });
    expect(submittedB.status).toBe('submitted');
    expect((await getTender(admin, tender.id)).bidCount).toBe(2);

    // Competitor isolation: by id and through listings, at every stage.
    await expect(getBid(contractorB, bidA.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(addBidRevision(contractorB, bidA.id, { amountKobo: '1', currency: 'NGN', lineItems: [], qualifications: {}, attachmentFileIds: [] })).rejects.toMatchObject({ code: 'not_found' });
    expect((await listTenderBids(contractorB, tender.id)).map((b) => b.id)).toEqual([bidB.id]);
    expect((await listMyBids(contractorB, { limit: 10 })).items.map((b) => b.id)).toEqual([bidB.id]);

    // Sealed for staff before the deadline: existence, partner and time only; no ids, amounts or revisions.
    const staffView = await listTenderBids(admin, tender.id);
    expect(staffView).toHaveLength(2);
    for (const b of staffView) {
      expect(b.sealed).toBe(true);
      expect(b.id).toBeNull();
      expect(b.submittedAt).not.toBeNull();
      expect('revisions' in b).toBe(false);
    }
    await expect(getBid(admin, bidA.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(openTenderBids(admin, tender.id, { reason: 'curiosity' })).rejects.toMatchObject({ code: 'invalid_transition' });
    expect(await listTenderBids(customerA, tender.id)).toEqual([]);
    await expect(getTenderComparison(admin, tender.id)).rejects.toMatchObject({ code: 'not_found' });

    // Closing early is refused; after the deadline nothing can be submitted, revised or withdrawn.
    await expect(closeTender(admin, tender.id)).rejects.toMatchObject({ code: 'invalid_transition' });
    await setDeadline(tender.id, new Date(Date.now() - 60_000));
    await expect(submitBid(contractorA, bidA.id, { revision: { amountKobo: '1', currency: 'NGN', lineItems: [], qualifications: {}, attachmentFileIds: [] } })).rejects.toMatchObject({ code: 'deadline_passed' });
    await expect(addBidRevision(contractorA, bidA.id, { amountKobo: '1', currency: 'NGN', lineItems: [], qualifications: {}, attachmentFileIds: [] })).rejects.toMatchObject({ code: 'deadline_passed' });
    await expect(withdrawBid(contractorA, bidA.id, { reason: 'changed my mind' })).rejects.toMatchObject({ code: 'deadline_passed' });
    await expect(askTenderQuestion(contractorA, tender.id, { question: 'Too late question?' })).rejects.toMatchObject({ code: 'deadline_passed' });
    const closed = await closeTender(admin, tender.id);
    expect(closed.status).toBe('closed');

    // Closed but not opened: still sealed for staff (rows visible, content not) and for customers.
    const closedView = await listTenderBids(admin, tender.id);
    expect(closedView.every((b) => b.sealed && b.id !== null)).toBe(true);
    const staffRead = await getBid(admin, bidA.id);
    expect(staffRead.sealed).toBe(true);
    expect('latestRevision' in staffRead).toBe(false);
    expect((await listTenderBids(customerA, tender.id)).every((b) => b.sealed)).toBe(true);
    await expect(getTenderComparison(admin, tender.id)).rejects.toMatchObject({ code: 'forbidden', details: { code: 'bids_sealed' } });

    // Opening requires bids.open_sealed with MFA on the actor.
    await expect(startEvaluation(opsManager, tender.id, { reason: 'evaluation start' })).rejects.toMatchObject({ name: 'AuthorizationError' });
    await expect(startEvaluation(adminNoMfa, tender.id, { reason: 'evaluation start' })).rejects.toMatchObject({ decision: { code: 'mfa_required' } });
    const evaluating = await startEvaluation(admin, tender.id, { reason: 'Deadline passed; opening for evaluation panel' });
    expect(evaluating.openedBidIds.sort()).toEqual([bidA.id, bidB.id].sort());
    const log = await dbs.owner.select().from(schema.bidAccessLog);
    expect(log.filter((l) => l.action === 'open').map((l) => l.bidId).sort()).toEqual([bidA.id, bidB.id].sort());

    // Evaluation: content visible, reads logged, scores weighted and ranked.
    const opened = await getBid(admin, bidA.id);
    expect(opened.sealed).toBe(false);
    if ('latestRevision' in opened) expect(opened.latestRevision?.amountKobo).toBe('150000000000');
    expect((await dbs.owner.select().from(schema.bidAccessLog)).some((l) => l.action === 'read' && l.bidId === bidA.id && l.userId === 'tnd-admin')).toBe(true);
    await expect(scoreBid(admin, bidA.id, { scores: { price: 70 } })).rejects.toMatchObject({ code: 'validation_failed' });
    await scoreBid(admin, bidA.id, { scores: { price: 70, quality: 90 } });
    await scoreBid(admin, bidB.id, { scores: { price: 90, quality: 60 } });
    await scoreBid(opsManager, bidB.id, { scores: { price: 80, quality: 60 }, notes: 'strong price' });
    const comparison = await getTenderComparison(admin, tender.id);
    const rowA = comparison.bids.find((b) => b.bidId === bidA.id)!;
    const rowB = comparison.bids.find((b) => b.bidId === bidB.id)!;
    expect(rowA.averageWeightedScore).toBe('78.0000');
    expect(rowB.averageWeightedScore).toBe('75.0000');
    expect(rowB.evaluatorCount).toBe(2);
    expect([rowA.rank, rowB.rank]).toEqual([1, 2]);
    // Customers see content only after close and opening, and those reads are logged too.
    const customerBids = await listTenderBids(customerA, tender.id);
    expect(customerBids.every((b) => b.sealed === false)).toBe(true);
    expect((await dbs.owner.select().from(schema.bidAccessLog)).some((l) => l.action === 'read' && l.userId === 'tnd-customer-a')).toBe(true);
    await expect(listTenderBids(customerB, tender.id)).rejects.toMatchObject({ code: 'not_found' });

    // Award: invisible to partners until published.
    const current = await getTender(admin, tender.id);
    const award = await decideAward(admin, tender.id, { bidId: bidB.id, notes: 'Best value', expectedVersion: current.version });
    expect(award.status).toBe('decided');
    expect(award.contractValueKobo).toBe('140000000000');
    await expect(getAward(contractorB, tender.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(getAward(contractorA, tender.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(getAward(customerA, tender.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await listMyAwards(contractorB, { limit: 10 })).items).toEqual([]);
    const awardedRows = await dbs.owner.select({ status: schema.bids.status }).from(schema.bids).where(eq(schema.bids.id, bidA.id));
    expect(awardedRows[0]?.status).toBe('evaluated');

    const afterDecide = await getTender(admin, tender.id);
    const publishedAward = await publishAward(admin, tender.id, { expectedVersion: afterDecide.version });
    expect(publishedAward.status).toBe('published');
    expect((await getTender(admin, tender.id)).status).toBe('awarded');
    const winner = await getAward(contractorB, tender.id);
    expect(winner).toMatchObject({ outcome: 'awarded', bidStatus: 'awarded' });
    expect((winner as { award: { bidId: string } | null }).award?.bidId).toBe(bidB.id);
    const loser = await getAward(contractorA, tender.id);
    expect(loser).toMatchObject({ outcome: 'unsuccessful', bidStatus: 'unsuccessful', award: null });
    expect((await listMyAwards(contractorA, { limit: 10 })).items[0]?.outcome).toBe('unsuccessful');
    expect(await getAward(customerA, tender.id)).toMatchObject({ status: 'published' });
    const jobs = await dbs.owner.select().from(schema.jobs).where(eq(schema.jobs.type, 'tenders.notify_award'));
    expect(jobs).toHaveLength(1);
    await expect(respondToAward(contractorA, tender.id, { decision: 'accept' })).rejects.toMatchObject({ code: 'not_found' });
    expect((await respondToAward(contractorB, tender.id, { decision: 'accept' })).status).toBe('accepted');
  });
});
