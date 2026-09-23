import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, schema } from '@simplexd/db';
import { addWarranty, createAsset, getAsset, listAssets } from './assets';
import {
  addEvidence,
  approveWorkOrder,
  assignWorkOrder,
  cancelWorkOrder,
  checkSlaBreaches,
  closeWorkOrder,
  completeWorkOrder,
  createWorkOrder,
  generateRecurringWorkOrders,
  getWorkOrder,
  listWorkOrders,
  requestApproval,
  startWorkOrder,
  triageWorkOrder,
  verifyWorkOrder,
} from './work-orders';
import { generateOwnerStatement, reconcileOwnerStatement } from '@/server/rentals/owner-statements';
import {
  ALL_FLAGS,
  createRentalFixture,
  enableFlags,
  errorCode,
  insertFile,
  journalLinesByRef,
  ledgerBalanced,
  opsIdentity,
  ownerIdentity,
  partnerIdentity,
  supportIdentity,
  tenantIdentity,
  type RentalFixture,
} from '@/server/rentals/testing/fixtures';

/**
 * Acceptance scenario 9 (maintenance side): request → assignment → evidence
 * → approval → expense journal, with SLA breach flags, assets and
 * recurring work orders behind the preventive-maintenance flag.
 */

let f: RentalFixture;

beforeAll(async () => {
  f = await createRentalFixture();
});

afterAll(async () => {
  await closeDb();
  await f.dbs.close();
});

describe('work orders', () => {
  it('runs request → triage → assign → evidence → approval → complete → verify (expense journal) → close', async () => {
    const owner = ownerIdentity(f, 'A');
    const ops = opsIdentity(f);
    const partner = partnerIdentity(f);
    const wo = await createWorkOrder(owner, { propertyId: f.propertyA, unitId: f.unitA1, title: 'Broken water heater', description: 'No hot water', category: 'plumbing', priority: 'high' });
    expect(wo.status).toBe('requested');
    expect(wo.slaDueAt).not.toBeNull();
    expect(wo.slaBreached).toBe(false);
    // Another organisation cannot see it; support cannot triage; the owner cannot triage.
    await expect(getWorkOrder(ownerIdentity(f, 'B'), wo.id)).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    await expect(triageWorkOrder(supportIdentity(f), wo.id, { expectedVersion: 1 })).rejects.toSatisfy((e) => ['forbidden', 'not_found'].includes(errorCode(e)!));
    await expect(triageWorkOrder(owner, wo.id, { expectedVersion: 1 })).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');

    const triaged = await triageWorkOrder(ops, wo.id, { priority: 'urgent', estimateKobo: '8000000', expectedVersion: 1 });
    expect(triaged.status).toBe('triaged');
    expect(triaged.priority).toBe('urgent');
    await expect(assignWorkOrder(ops, wo.id, { assigneeUserId: f.tenant1, expectedVersion: 2 })).rejects.toSatisfy((e) => errorCode(e) === 'validation_failed');
    const assigned = await assignWorkOrder(ops, wo.id, { assigneeUserId: f.partner, instructions: 'Replace the heater element', expectedVersion: 2 });
    expect(assigned).toMatchObject({ status: 'assigned', assigneeUserId: f.partner, assigneeName: f.partner });
    const [assignment] = await f.dbs.owner.select().from(schema.assignments).where(eq(schema.assignments.assigneeUserId, f.partner));
    expect(assignment).toMatchObject({ role: 'contractor', status: 'accepted', organizationId: f.orgA });

    // The partner sees the work order through the assignment and starts it.
    expect((await getWorkOrder(partner, wo.id)).status).toBe('assigned');
    await expect(startWorkOrder(tenantIdentity(f, 2), wo.id, { expectedVersion: 3 })).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    const started = await startWorkOrder(partner, wo.id, { expectedVersion: 3 });
    expect(started.status).toBe('in_progress');
    const awaiting = await requestApproval(partner, wo.id, { estimateKobo: '9500000', expectedVersion: 4 });
    expect(awaiting.status).toBe('awaiting_approval');
    // Only the owner organisation approves the cost.
    await expect(approveWorkOrder(partner, wo.id, { approvedAmountKobo: '9500000', expectedVersion: 5 })).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    await expect(approveWorkOrder(ops, wo.id, { approvedAmountKobo: '9500000', expectedVersion: 5 })).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    const approved = await approveWorkOrder(owner, wo.id, { approvedAmountKobo: '9500000', expectedVersion: 5 });
    expect(approved).toMatchObject({ status: 'approved', approvedAmountKobo: '9500000', approvedBy: f.ownerA });

    // Completion needs evidence.
    await expect(completeWorkOrder(partner, wo.id, { actualCostKobo: '9200000', expectedVersion: 6 })).rejects.toSatisfy((e) => errorCode(e) === 'insufficient_evidence');
    const foreignFile = await insertFile(f.dbs.owner, f.orgB, f.ownerB);
    await expect(addEvidence(partner, wo.id, { fileIds: [foreignFile] })).rejects.toSatisfy((e) => ['validation_failed', 'not_found'].includes(errorCode(e)!));
    const photo = await insertFile(f.dbs.owner, f.orgA, f.partner);
    const withEvidence = await addEvidence(partner, wo.id, { fileIds: [photo], caption: 'New element fitted' });
    expect(withEvidence.evidence).toHaveLength(1);
    expect(withEvidence.evidence[0]).toMatchObject({ fileId: photo, kind: 'photo', uploaderUserId: f.partner });
    const completed = await completeWorkOrder(partner, wo.id, { actualCostKobo: '9200000', expectedVersion: 6 });
    expect(completed.status).toBe('completed');
    expect(completed.completedAt).not.toBeNull();

    // Verification records the recoverable expense: Dr 5200 / Cr 2400, balanced.
    await expect(verifyWorkOrder(partner, wo.id, { expectedVersion: 7 })).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    await expect(verifyWorkOrder(ops, wo.id, { costKobo: '9900000', expectedVersion: 7 })).rejects.toSatisfy((e) => errorCode(e) === 'validation_failed');
    const verified = await verifyWorkOrder(ops, wo.id, { expectedVersion: 7 });
    expect(verified.status).toBe('verified');
    expect(verified.actualCostKobo).toBe('9200000');
    expect(verified.expenseJournalId).not.toBeNull();
    expect(await journalLinesByRef(f.dbs.owner, `work_order:${wo.id}:expense`)).toEqual([
      { code: '5200', debitKobo: 9_200_000n, creditKobo: 0n },
      { code: '2400', debitKobo: 0n, creditKobo: 9_200_000n },
    ]);
    const closed = await closeWorkOrder(ops, wo.id, { expectedVersion: 8 });
    expect(closed.status).toBe('closed');
    await expect(closeWorkOrder(ops, wo.id, { expectedVersion: 9 })).rejects.toSatisfy((e) => errorCode(e) === 'invalid_transition');

    // The owner statement recovers the expense from the owner's rent balance (Dr 2100 / Cr 5200).
    const statement = await generateOwnerStatement(ops, { organizationId: f.orgA, propertyId: f.propertyA, periodStart: '2026-01-01', periodEnd: '2026-12-31' });
    expect(statement.totals.expensesKobo).toBe('9200000');
    expect(statement.totals.netKobo).toBe('-9200000');
    const reconciled = await reconcileOwnerStatement(ops, statement.id);
    expect(reconciled.status).toBe('reconciled');
    expect((await journalLinesByRef(f.dbs.owner, `work_order:${wo.id}:recovered`)).map((l) => l.code)).toEqual(['2100', '5200']);
    const ledger = await ledgerBalanced(f.dbs.owner);
    expect(ledger.unbalancedJournals).toBe(0);
    expect(ledger.debitKobo).toBe(ledger.creditKobo);

    const audit = await f.dbs.owner.select({ action: schema.auditEvents.action }).from(schema.auditEvents).where(eq(schema.auditEvents.entityId, wo.id));
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['work_order.requested', 'work_order.triaged', 'work_order.assigned', 'work_order.in_progress', 'work_order.approval_requested', 'work_order.approved', 'work_order.evidence_added', 'work_order.completed', 'work_order.verified', 'work_order.closed']),
    );
    const events = await f.dbs.owner.select({ payload: schema.outboxEvents.payload }).from(schema.outboxEvents).where(eq(schema.outboxEvents.aggregateId, wo.id));
    expect(events.length).toBeGreaterThanOrEqual(8);
  });

  it('flags SLA breaches once, lists them and lets the owner cancel with a reason', async () => {
    const owner = ownerIdentity(f, 'A');
    const wo = await createWorkOrder(owner, { propertyId: f.propertyA, title: 'Gate motor', category: 'electrical', priority: 'urgent' });
    await f.dbs.owner.update(schema.workOrders).set({ slaDueAt: new Date(Date.now() - 3_600_000) }).where(eq(schema.workOrders.id, wo.id));
    expect(await checkSlaBreaches(f.dbs.app)).toBe(1);
    expect(await checkSlaBreaches(f.dbs.app)).toBe(0);
    const breached = await listWorkOrders(opsIdentity(f), { limit: 10, breachedOnly: true, organizationId: f.orgA });
    expect(breached.items.map((w) => w.id)).toEqual([wo.id]);
    expect(breached.items[0]!.slaBreached).toBe(true);
    expect((await listWorkOrders(ownerIdentity(f, 'B'), { limit: 10 })).items.some((w) => w.id === wo.id)).toBe(false);
    await expect(cancelWorkOrder(owner, wo.id, { reason: '', expectedVersion: 1 })).rejects.toSatisfy((e) => errorCode(e) === 'invalid_transition');
    const cancelled = await cancelWorkOrder(owner, wo.id, { reason: 'Fixed by the estate', expectedVersion: 1 });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.slaBreached).toBe(false);
  });
});

describe('assets and preventive maintenance', () => {
  it('is gated by the flag, keeps warranties and generates recurring work orders', async () => {
    const owner = ownerIdentity(f, 'A');
    await expect(createAsset(owner, { propertyId: f.propertyA, name: 'Generator', category: 'power', condition: 'good' })).rejects.toSatisfy((e) => errorCode(e) === 'feature_disabled');
    await expect(listAssets(owner, { limit: 10 })).rejects.toSatisfy((e) => errorCode(e) === 'feature_disabled');
    // The job does nothing while the flag is off.
    expect(await generateRecurringWorkOrders(f.dbs.app, '2026-09-22')).toBe(0);

    await enableFlags(f.dbs.owner);
    const flagged = ownerIdentity(f, 'A', ALL_FLAGS);
    const asset = await createAsset(flagged, { propertyId: f.propertyA, name: 'Generator 20kVA', category: 'power', condition: 'good', installedAt: '2025-01-10', nextServiceAt: '2026-09-01', serviceIntervalDays: 90 });
    expect(asset.organizationId).toBe(f.orgA);
    const withWarranty = await addWarranty(flagged, asset.id, { provider: 'Mikano', reference: 'W-1', startsAt: '2025-01-10', expiresAt: '2027-01-10' });
    expect(withWarranty.warranties[0]).toMatchObject({ provider: 'Mikano', status: 'active' });
    await expect(getAsset(ownerIdentity(f, 'B', ALL_FLAGS), asset.id)).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    expect((await listAssets(flagged, { limit: 10, serviceDueBefore: '2026-09-22' })).items.map((a) => a.id)).toEqual([asset.id]);

    expect(await generateRecurringWorkOrders(f.dbs.app, '2026-09-22')).toBe(1);
    expect(await generateRecurringWorkOrders(f.dbs.app, '2026-09-22')).toBe(0);
    const [recurring] = await f.dbs.owner.select().from(schema.workOrders).where(eq(schema.workOrders.assetId, asset.id));
    expect(recurring).toMatchObject({ category: 'preventive', status: 'requested', propertyId: f.propertyA });
    expect((await getAsset(flagged, asset.id)).nextServiceAt).toBe('2026-12-21');
  });
});
