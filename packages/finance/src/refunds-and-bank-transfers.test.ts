import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@simplexd/db';
import { connectTestDatabases, type TestDatabases } from '@simplexd/db/testing';
import type { DevPaymentProvider } from '@simplexd/integrations/payments';
import type { FinanceActor } from './actor';
import {
  confirmBankTransferReceipt,
  rejectBankTransferReceipt,
  submitBankTransferReceipt,
} from './bank-transfers';
import { issueCreditNote } from './credit-notes';
import { createInvoice, getInvoice, voidInvoice } from './invoices';
import { createPaymentAttempt, verifyPaymentAttempt } from './payment-attempts';
import { approveRefund, rejectRefund, requestRefund } from './refunds';
import { listReceiptsForInvoice } from './receipts';
import type { FinanceRuntime } from './runtime';
import {
  assertLedgerBalanced,
  countReceiptsForInvoice,
  customerActor,
  devProviderRuntime,
  journalByRef,
  seedTenants,
  staffActor,
  type Tenants,
} from './testing/fixtures';

let dbs: TestDatabases;
let t: Tenants;
let rt: FinanceRuntime;
let dev: DevPaymentProvider;
let customerA: FinanceActor;
let customerB: FinanceActor;
let finance1: FinanceActor;
let finance2: FinanceActor;

async function issuedInvoice(amountKobo = '5000000'): Promise<string> {
  const invoice = await createInvoice(rt, finance1, {
    organizationId: t.orgA,
    customerUserId: t.userA,
    kind: 'service',
    lines: [{ description: 'Inspection', quantity: '1', unitAmountKobo: amountKobo }],
    currency: 'NGN',
    issue: true,
  });
  return invoice.id;
}

beforeAll(async () => {
  dbs = connectTestDatabases();
  t = await seedTenants(dbs.owner);
  ({ rt, dev } = devProviderRuntime(dbs.app));
  customerA = customerActor({ userId: t.userA, organizationId: t.orgA });
  customerB = customerActor({ userId: t.userB, organizationId: t.orgB });
  finance1 = staffActor({ userId: t.financeUser1, roles: ['finance'] });
  finance2 = staffActor({ userId: t.financeUser2, roles: ['finance'] });
});

afterAll(async () => {
  await dbs.close();
});

describe('refund approval', () => {
  it('requires a different approver with step-up authentication', async () => {
    const invoiceId = await issuedInvoice();
    const attempt = await createPaymentAttempt(rt, customerA, invoiceId, {});
    dev.simulate(attempt.reference, 'success');
    await verifyPaymentAttempt(rt, customerA, { id: attempt.id });

    const refund = await requestRefund(rt, finance1, {
      paymentAttemptId: attempt.id,
      reason: 'Duplicate booking',
    });
    expect(refund.status).toBe('requested');
    await expect(approveRefund(rt, finance1, refund.id, {})).rejects.toMatchObject({
      name: 'AuthorizationError',
      decision: { code: 'own_work' },
    });
    const noMfa = staffActor({ userId: t.financeUser2, roles: ['finance'], mfaVerified: false });
    await expect(approveRefund(rt, noMfa, refund.id, {})).rejects.toMatchObject({
      name: 'AuthorizationError',
      decision: { code: 'mfa_required' },
    });
    const ops = staffActor({ userId: t.opsUser, roles: ['operations_manager'] });
    await expect(approveRefund(rt, ops, refund.id, {})).rejects.toMatchObject({
      name: 'AuthorizationError',
      decision: { code: 'no_permission' },
    });
    await expect(approveRefund(rt, customerA, refund.id, {})).rejects.toMatchObject({
      name: 'AuthorizationError',
    });

    const approved = await approveRefund(rt, finance2, refund.id, {
      reason: 'Confirmed duplicate',
    });
    expect(approved.status).toBe('approved');
    expect(approved.approvedBy).toBe(t.financeUser2);
    expect(await journalByRef(dbs.owner, `refund:${refund.id}:approved`)).not.toBeNull();
    const outbox = await dbs.owner
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.aggregateId, refund.id));
    expect(outbox.map((e) => e.eventType)).toContain('refund.approved');

    // Over-refunding and rejecting are guarded too.
    await expect(
      requestRefund(rt, finance1, {
        paymentAttemptId: attempt.id,
        amountKobo: '1',
        reason: 'too much',
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const invoice2 = await issuedInvoice();
    const attempt2 = await createPaymentAttempt(rt, customerA, invoice2, {});
    dev.simulate(attempt2.reference, 'success');
    await verifyPaymentAttempt(rt, customerA, { id: attempt2.id });
    const second = await requestRefund(rt, customerA, {
      paymentAttemptId: attempt2.id,
      reason: 'Changed my mind',
    });
    const rejected = await rejectRefund(rt, finance2, second.id, {
      reason: 'Service already delivered',
    });
    expect(rejected.status).toBe('rejected');
    expect(await journalByRef(dbs.owner, `refund:${second.id}:approved`)).toBeNull();
  });
});

describe('bank transfers', () => {
  it('a declared receipt posts nothing; finance confirmation allocates and posts exactly once', async () => {
    const invoiceId = await issuedInvoice('3000000');
    await expect(
      submitBankTransferReceipt(rt, customerB, invoiceId, { declaredAmountKobo: '3000000' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const declared = await submitBankTransferReceipt(rt, customerA, invoiceId, {
      declaredAmountKobo: '3000000',
      bankReference: 'GTB/12345',
      declaredPaidAt: '2026-09-20',
    });
    expect(declared.status).toBe('submitted');
    expect((await getInvoice(rt, customerA, invoiceId)).amountPaidKobo).toBe('0');
    expect(
      await journalByRef(dbs.owner, `bank_transfer_receipt:${declared.id}:confirmed`),
    ).toBeNull();

    await expect(
      confirmBankTransferReceipt(rt, customerA, declared.id, { confirmedAmountKobo: '3000000' }),
    ).rejects.toMatchObject({ name: 'AuthorizationError' });
    const noMfa = staffActor({ userId: t.financeUser1, roles: ['finance'], mfaVerified: false });
    await expect(
      confirmBankTransferReceipt(rt, noMfa, declared.id, { confirmedAmountKobo: '3000000' }),
    ).rejects.toMatchObject({ decision: { code: 'mfa_required' } });

    const confirmed = await confirmBankTransferReceipt(rt, finance1, declared.id, {
      confirmedAmountKobo: '3000000',
      note: 'Seen on statement 21 Sep',
    });
    expect(confirmed.receipt.status).toBe('confirmed');
    expect(confirmed.invoiceStatus).toBe('paid');
    expect(confirmed.receiptNumber).toMatch(/^RCT-\d{4}-\d{4}$/);
    await expect(
      confirmBankTransferReceipt(rt, finance1, declared.id, { confirmedAmountKobo: '3000000' }),
    ).rejects.toMatchObject({ code: 'conflict' });

    const allocations = await dbs.owner
      .select()
      .from(schema.allocations)
      .where(eq(schema.allocations.bankReceiptId, declared.id));
    expect(allocations).toHaveLength(1);
    expect(allocations[0]!.dedupeKey).toBe(`bank_receipt:${declared.id}`);
    expect(await countReceiptsForInvoice(dbs.owner, invoiceId)).toBe(1);
    expect(
      await journalByRef(dbs.owner, `bank_transfer_receipt:${declared.id}:confirmed`),
    ).not.toBeNull();
    const receipts = await listReceiptsForInvoice(rt, customerA, invoiceId);
    expect(receipts[0]).toMatchObject({ source: 'bank_transfer', amountKobo: '3000000' });
    await expect(listReceiptsForInvoice(rt, customerB, invoiceId)).rejects.toMatchObject({
      code: 'not_found',
    });

    const invoice2 = await issuedInvoice('1000000');
    const declined = await submitBankTransferReceipt(rt, customerA, invoice2, {
      declaredAmountKobo: '1000000',
    });
    const rejected = await rejectBankTransferReceipt(rt, finance1, declined.id, {
      note: 'No matching credit on the statement',
    });
    expect(rejected.status).toBe('rejected');
    expect((await getInvoice(rt, customerA, invoice2)).status).toBe('issued');
  });
});

describe('credit notes and voids', () => {
  it('credit notes reduce the balance through one allocation; voids reverse the issue journal', async () => {
    const invoiceId = await issuedInvoice('4000000');
    const note = await issueCreditNote(rt, finance1, invoiceId, {
      amountKobo: '1000000',
      reason: 'Goodwill discount',
    });
    expect(note.number).toMatch(/^CN-\d{4}-\d{4}$/);
    expect(note.status).toBe('applied');
    const afterCredit = await getInvoice(rt, customerA, invoiceId);
    expect(afterCredit.amountCreditedKobo).toBe('1000000');
    expect(afterCredit.balanceKobo).toBe('3000000');
    expect(afterCredit.status).toBe('issued');
    expect(await journalByRef(dbs.owner, `credit_note:${note.id}:issued`)).not.toBeNull();
    await expect(
      issueCreditNote(rt, customerA, invoiceId, { amountKobo: '1', reason: 'nope' }),
    ).rejects.toMatchObject({ name: 'AuthorizationError' });

    const toVoid = await issuedInvoice('2000000');
    await expect(voidInvoice(rt, finance1, invoiceId, 'has a credit note')).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    const voided = await voidInvoice(rt, finance1, toVoid, 'Raised in error');
    expect(voided.status).toBe('void');
    expect(await journalByRef(dbs.owner, `invoice:${toVoid}:void`)).not.toBeNull();
    await expect(createPaymentAttempt(rt, customerA, toVoid, {})).rejects.toMatchObject({
      code: 'invalid_transition',
    });

    const balance = await assertLedgerBalanced(dbs.owner);
    expect(balance.debitKobo).toBe(balance.creditKobo);
    expect(balance.unbalancedJournals).toBe(0);
  });
});
