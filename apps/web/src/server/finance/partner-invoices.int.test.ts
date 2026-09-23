import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PurchaseOrderDetail } from '@simplexd/contracts';
import { closeDb, schema } from '@simplexd/db';
import { connectTestDatabases, type TestDatabases } from '@simplexd/db/testing';
import {
  insertPartnerFile,
  issuedPurchaseOrderFor,
  seedChainFixture,
  type ChainFixture,
} from '@/server/procurement/testing/purchase-order-chain';
import { errorCode } from '@/server/projects/testing/fixtures';
import { staffIdentity } from '@/server/tenders/test-fixtures';
import {
  acceptPartnerInvoice,
  failPartnerInvoicePayment,
  getPartnerInvoice,
  listPartnerInvoices,
  rejectPartnerInvoice,
  secondApprovePartnerInvoice,
  settlePartnerInvoice,
  submitPartnerInvoice,
  submitPartnerInvoicePayment,
} from './partner-invoices';

/**
 * Partner invoices: a vendor bills an order issued to them; finance accepts
 * (posting the payable) or rejects; a different approver authorises payment;
 * settlement posts the bank leg. Nobody outside finance can move an invoice,
 * one person can never give both approvals, and every journal balances.
 */

let dbs: TestDatabases;
let f: ChainFixture;
let po: PurchaseOrderDetail;
let attachment: string;

beforeAll(async () => {
  dbs = connectTestDatabases();
  f = await seedChainFixture(dbs.owner);
  po = await issuedPurchaseOrderFor(f, f.vendorA, 'Cement for the Ajah site');
  attachment = await insertPartnerFile(dbs.owner, f.vendorAId);
});

afterAll(async () => {
  await closeDb();
  await dbs.close();
});

async function journalTotals(journalId: string) {
  const lines = await dbs.owner
    .select({
      code: schema.ledgerAccounts.code,
      debit: schema.journalLines.debitKobo,
      credit: schema.journalLines.creditKobo,
    })
    .from(schema.journalLines)
    .innerJoin(schema.ledgerAccounts, eq(schema.ledgerAccounts.id, schema.journalLines.accountId))
    .where(eq(schema.journalLines.journalId, journalId));
  const debit = lines.reduce((s, l) => s + l.debit, 0n);
  const credit = lines.reduce((s, l) => s + l.credit, 0n);
  return { lines, debit, credit };
}

async function journalByRef(ref: string) {
  const [row] = await dbs.owner
    .select({ id: schema.journals.id })
    .from(schema.journals)
    .where(eq(schema.journals.businessEventRef, ref));
  return row ?? null;
}

const submission = (reference: string, amountKobo: string, fileId = attachment) => ({
  source: { type: 'purchase_order' as const, id: po.id },
  amountKobo,
  currency: 'NGN',
  reference,
  attachmentFileId: fileId,
});

describe('partner invoices', () => {
  it('a vendor submits against its own issued order; competitors and customers see nothing', async () => {
    expect(await errorCode(submitPartnerInvoice(f.vendorB, submission('VB-1', '1000')))).toBe(
      'not_found',
    );
    expect(await errorCode(submitPartnerInvoice(f.customer, submission('CU-1', '1000')))).toBe(
      'forbidden',
    );
    const competitorFile = await insertPartnerFile(dbs.owner, f.vendorBId);
    expect(
      await errorCode(submitPartnerInvoice(f.vendorA, submission('VA-x', '1000', competitorFile))),
    ).toBe('validation_failed');
    const scanning = await insertPartnerFile(dbs.owner, f.vendorAId, 'scanning');
    expect(
      await errorCode(submitPartnerInvoice(f.vendorA, submission('VA-y', '1000', scanning))),
    ).toBe('file_quarantined');
    // The order total is 120,000,000 kobo: invoices may not exceed it.
    expect(
      await errorCode(submitPartnerInvoice(f.vendorA, submission('VA-big', '120000001'))),
    ).toBe('validation_failed');

    const invoice = await submitPartnerInvoice(f.vendorA, submission('VA-001', '50000000'));
    expect(invoice).toMatchObject({
      status: 'proposed',
      partnerUserId: f.vendorAId,
      organizationId: f.orgId,
      amountKobo: '50000000',
      reference: 'VA-001',
      attachmentFileId: attachment,
      review: null,
    });
    expect(invoice.source).toMatchObject({ type: 'purchase_order', id: po.id });
    expect(invoice.source.label).toContain(po.number);
    expect(invoice.history.map((h) => h.action)).toEqual(['submitted']);
    expect(await errorCode(submitPartnerInvoice(f.vendorA, submission('VA-001', '1000')))).toBe(
      'conflict',
    );

    expect((await listPartnerInvoices(f.vendorA, { limit: 10 })).items.map((i) => i.id)).toEqual([
      invoice.id,
    ]);
    expect((await listPartnerInvoices(f.vendorB, { limit: 10 })).items).toEqual([]);
    expect(await errorCode(getPartnerInvoice(f.vendorB, invoice.id))).toBe('not_found');
    expect(await errorCode(listPartnerInvoices(f.customer, { limit: 10 }))).toBe('forbidden');
    expect(
      (await listPartnerInvoices(f.financeA, { limit: 50, partnerUserId: f.vendorAId })).items.map(
        (i) => i.id,
      ),
    ).toContain(invoice.id);
    const [event] = await dbs.owner
      .select()
      .from(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.eventType, 'partner_invoice.submitted'),
          eq(schema.outboxEvents.aggregateId, invoice.id),
        ),
      );
    expect(event?.payload).toMatchObject({ partnerUserId: f.vendorAId, sourceId: po.id });
  });

  it('finance accepts (payable posted), a different approver authorises, settlement posts the bank leg', async () => {
    const [invoice] = (await listPartnerInvoices(f.vendorA, { limit: 1 })).items;
    const id = invoice!.id;
    expect(await errorCode(acceptPartnerInvoice(f.vendorA, id, {}))).toBe('forbidden');
    expect(await errorCode(acceptPartnerInvoice(f.staff, id, {}))).toBe('forbidden:no_permission');
    const financeNoMfa = staffIdentity(f.financeAId, ['finance'], { mfaVerified: false });
    expect(await errorCode(acceptPartnerInvoice(financeNoMfa, id, {}))).toBe(
      'forbidden:mfa_required',
    );

    const accepted = await acceptPartnerInvoice(f.financeA, id, { note: 'Matches the order' });
    expect(accepted.status).toBe('first_approved');
    expect(accepted.firstApproverId).toBe(f.financeAId);
    expect(accepted.review).toMatchObject({ decision: 'accepted', byUserId: f.financeAId });
    expect(accepted.journalId).not.toBeNull();
    const payable = await journalTotals(accepted.journalId!);
    expect(payable.debit).toBe(50_000_000n);
    expect(payable.credit).toBe(50_000_000n);
    expect(payable.lines.find((l) => l.debit > 0n)?.code).toBe('5200');
    expect(payable.lines.find((l) => l.credit > 0n)?.code).toBe('2400');

    // Separation of duties: the same approver cannot give the second approval.
    expect(await errorCode(secondApprovePartnerInvoice(f.financeA, id))).toMatch(
      /forbidden(:separation_of_duties)?/,
    );
    const approved = await secondApprovePartnerInvoice(f.financeB, id);
    expect(approved.status).toBe('approved');
    expect(approved.secondApproverId).toBe(f.financeBId);
    // Settling before the transfer is submitted is refused by the machine.
    expect(
      await errorCode(settlePartnerInvoice(f.financeB, id, { settlementReference: 'STMT-1' })),
    ).toBe('invalid_transition');
    const submitted = await submitPartnerInvoicePayment(f.financeB, id);
    expect(submitted.status).toBe('submitted');
    const settled = await settlePartnerInvoice(f.financeA, id, { settlementReference: 'STMT-77' });
    expect(settled.status).toBe('settled');
    expect(settled.settledAt).not.toBeNull();
    const settlement = await journalByRef(`payout:${id}:settled`);
    expect(settlement).not.toBeNull();
    const bank = await journalTotals(settlement!.id);
    expect(bank.debit).toBe(bank.credit);
    expect(bank.lines.find((l) => l.debit > 0n)?.code).toBe('2400');
    expect(bank.lines.find((l) => l.credit > 0n)?.code).toBe('1000');
    expect(settled.history.map((h) => h.action)).toEqual([
      'submitted',
      'accepted',
      'second_approved',
      'payment_submitted',
      'settled',
    ]);
    expect((await getPartnerInvoice(f.vendorA, id)).status).toBe('settled');
    const events = await dbs.owner
      .select()
      .from(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.eventType, 'partner_invoice.transitioned'),
          eq(schema.outboxEvents.aggregateId, id),
        ),
      );
    expect(events.map((e) => (e.payload as { to: string }).to)).toEqual([
      'first_approved',
      'approved',
      'submitted',
      'settled',
    ]);
    for (const e of events) expect(e.payload).toMatchObject({ recipientUserIds: [f.vendorAId] });
  });

  it('rejecting an accepted invoice reverses the payable and frees the order cap; failed transfers can be re-approved', async () => {
    // 50,000,000 is settled against a 120,000,000 order: 100,000,000 more would exceed it.
    expect(
      await errorCode(submitPartnerInvoice(f.vendorA, submission('VA-002', '100000000'))),
    ).toBe('validation_failed');
    const second = await submitPartnerInvoice(f.vendorA, submission('VA-002', '70000000'));
    const accepted = await acceptPartnerInvoice(f.financeA, second.id, {});
    const rejected = await rejectPartnerInvoice(f.financeB, second.id, {
      reason: 'Quantities on the invoice do not match the delivery note',
    });
    expect(rejected.status).toBe('rejected');
    expect(rejected.failureReason).toContain('delivery note');
    expect(rejected.review).toMatchObject({ decision: 'rejected', byUserId: f.financeBId });
    const reversal = await journalByRef(`payout:${second.id}:accepted:reversed`);
    expect(reversal).not.toBeNull();
    const totals = await journalTotals(reversal!.id);
    expect(totals.debit).toBe(totals.credit);
    expect(totals.lines.find((l) => l.debit > 0n)?.code).toBe('2400');
    expect(accepted.journalId).not.toBe(reversal!.id);
    // A rejected invoice no longer counts against the order.
    const third = await submitPartnerInvoice(f.vendorA, submission('VA-003', '70000000'));
    expect(third.status).toBe('proposed');
    expect(await errorCode(rejectPartnerInvoice(f.vendorA, third.id, { reason: 'x' }))).toBe(
      'forbidden',
    );
    await acceptPartnerInvoice(f.financeA, third.id, {});
    await secondApprovePartnerInvoice(f.financeB, third.id);
    await submitPartnerInvoicePayment(f.financeA, third.id);
    const failed = await failPartnerInvoicePayment(f.financeA, third.id, {
      reason: 'Bank rejected the account number',
    });
    expect(failed.status).toBe('failed');
    const reapproved = await secondApprovePartnerInvoice(f.financeB, third.id);
    expect(reapproved.status).toBe('approved');
  });

  it('assignment invoices need a completed assignment and post professional fees', async () => {
    const [assignment] = await dbs.owner
      .insert(schema.assignments)
      .values({
        organizationId: f.orgId,
        assigneeUserId: f.vendorAId,
        role: 'vendor',
        status: 'active',
        assignedBy: f.staffId,
      })
      .returning({ id: schema.assignments.id });
    const body = {
      source: { type: 'assignment' as const, id: assignment!.id },
      amountKobo: '2500000',
      currency: 'NGN',
      reference: 'VA-ASG-1',
      attachmentFileId: attachment,
    };
    expect(await errorCode(submitPartnerInvoice(f.vendorA, body))).toBe('invalid_transition');
    expect(await errorCode(submitPartnerInvoice(f.vendorB, body))).toBe('not_found');
    await dbs.owner
      .update(schema.assignments)
      .set({ status: 'completed' })
      .where(eq(schema.assignments.id, assignment!.id));
    const invoice = await submitPartnerInvoice(f.vendorA, body);
    expect(invoice.source).toMatchObject({ type: 'assignment', id: assignment!.id });
    const accepted = await acceptPartnerInvoice(f.financeB, invoice.id, {});
    const totals = await journalTotals(accepted.journalId!);
    expect(totals.debit).toBe(2_500_000n);
    expect(totals.lines.find((l) => l.debit > 0n)?.code).toBe('5300');
  });
});
