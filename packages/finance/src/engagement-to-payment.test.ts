import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@simplexd/db';
import { connectTestDatabases, type TestDatabases } from '@simplexd/db/testing';
import type { DevPaymentProvider } from '@simplexd/integrations/payments';
import {
  acceptQuote,
  createQuote,
  getQuote,
  issueQuote,
  listQuotesForRequest,
} from './engagements/quotes';
import { triageServiceRequest } from './engagements/triage';
import { getInvoice } from './invoices';
import { createPaymentAttempt, getPaymentAttempt, verifyPaymentAttempt } from './payment-attempts';
import type { FinanceRuntime } from './runtime';
import {
  assertLedgerBalanced,
  countAllocationsForAttempt,
  countReceiptsForInvoice,
  customerActor,
  devProviderRuntime,
  insertServiceRequest,
  journalByRef,
  seedTenants,
  staffActor,
  type Tenants,
} from './testing/fixtures';

/**
 * Acceptance scenario 3 (payment slice): a customer's request is triaged, a
 * versioned quote is issued and accepted, the invoice is issued, the customer
 * pays with the development adapter, the server verifies and settles once,
 * a receipt is issued once, every journal balances, and another organisation
 * is denied at every step.
 */

let dbs: TestDatabases;
let t: Tenants;
let rt: FinanceRuntime;
let dev: DevPaymentProvider;

beforeAll(async () => {
  dbs = connectTestDatabases();
  t = await seedTenants(dbs.owner);
  ({ rt, dev } = devProviderRuntime(dbs.app));
});

afterAll(async () => {
  await dbs.close();
});

describe('engagement → quote → acceptance → invoice → payment', () => {
  it('runs the full slice with balanced journals and isolation from another organisation', async () => {
    const customerA = customerActor({ userId: t.userA, organizationId: t.orgA });
    const customerB = customerActor({ userId: t.userB, organizationId: t.orgB });
    const ops = staffActor({ userId: t.opsUser, roles: ['operations_manager'] });
    const sr = await insertServiceRequest(dbs.owner, t, {
      organizationId: t.orgA,
      requestedByUserId: t.userA,
    });

    // Triage: assignment, priority and SLA from sla_policies.
    const triaged = await triageServiceRequest(rt, ops, sr.id, {
      assignedPmUserId: t.opsUser,
      priority: 2,
      expectedVersion: 1,
    });
    expect(triaged.status).toBe('triage');
    expect(triaged.slaDueAt).not.toBeNull();
    await expect(
      triageServiceRequest(rt, customerA, sr.id, {
        assignedPmUserId: t.opsUser,
        priority: 2,
        expectedVersion: 2,
      }),
    ).rejects.toMatchObject({ name: 'AuthorizationError' });

    // Quote drafted from lines; totals are recomputed on the server.
    const draft = await createQuote(rt, ops, sr.id, {
      lines: [
        { description: 'Title and document review', quantity: '1', unitAmountKobo: '10000000' },
        { description: 'Site visit', quantity: '2', unitAmountKobo: '2500000' },
      ],
      currency: 'NGN',
      depositBps: 10_000,
      requiresPayment: true,
      scopeMarkdown: 'One property, one visit.',
    });
    expect(draft.status).toBe('draft');
    expect(draft.versions[0]!.subtotalKobo).toBe('15000000');
    expect(draft.versions[0]!.totalKobo).toBe('15000000');

    const issued = await issueQuote(rt, ops, draft.id, { validDays: 7 });
    expect(issued.status).toBe('issued');
    expect(issued.versions[0]!.issuedAt).not.toBeNull();
    const [srQuoted] = await dbs.owner
      .select()
      .from(schema.serviceRequests)
      .where(eq(schema.serviceRequests.id, sr.id));
    expect(srQuoted!.status).toBe('quoted');

    // Organisation B cannot see or accept the quote.
    await expect(getQuote(rt, customerB, issued.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(listQuotesForRequest(rt, customerB, sr.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      acceptQuote(rt, customerB, issued.id, {
        quoteVersionId: issued.versions[0]!.id,
        signatureName: 'Bola B',
        termsVersion: '2026-09',
        acceptTerms: true,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });

    // Customer A accepts: acceptance recorded, invoice issued, engagement awaiting payment.
    const accepted = await acceptQuote(rt, customerA, issued.id, {
      quoteVersionId: issued.versions[0]!.id,
      signatureName: 'Ada A',
      termsVersion: '2026-09',
      acceptTerms: true,
    });
    expect(accepted.quote.status).toBe('accepted');
    expect(accepted.engagementStatus).toBe('awaiting_payment');
    expect(accepted.invoiceId).not.toBeNull();
    expect(accepted.quote.acceptance).toMatchObject({
      signatureName: 'Ada A',
      termsVersion: '2026-09',
      acceptedByUserId: t.userA,
    });
    const [acceptanceRow] = await dbs.owner
      .select()
      .from(schema.acceptances)
      .where(eq(schema.acceptances.quoteVersionId, issued.versions[0]!.id));
    expect(acceptanceRow).toMatchObject({ ipHash: 'iphash-test', userAgent: 'vitest' });

    const invoice = await getInvoice(rt, customerA, accepted.invoiceId!);
    expect(invoice.status).toBe('issued');
    expect(invoice.number).toMatch(/^INV-\d{4}-\d{4}$/);
    expect(invoice.totalKobo).toBe('15000000');
    expect(invoice.balanceKobo).toBe('15000000');
    expect(await journalByRef(dbs.owner, `invoice:${invoice.id}:issued`)).not.toBeNull();
    await expect(getInvoice(rt, customerB, invoice.id)).rejects.toMatchObject({
      code: 'not_found',
    });

    // Payment attempt with the development adapter.
    await expect(createPaymentAttempt(rt, customerB, invoice.id, {})).rejects.toMatchObject({
      code: 'not_found',
    });
    const attempt = await createPaymentAttempt(rt, customerA, invoice.id, {});
    expect(attempt.status).toBe('pending');
    expect(attempt.reference).toMatch(/^SXD-[0-9A-F]{12}$/);
    expect(attempt.amountKobo).toBe('15000000');
    expect(attempt.authorizationUrl).toContain('/dev/paystack-checkout');
    expect(attempt.developmentAdapter).toBe(true);
    expect(attempt.environment).toBe('test');
    await expect(getPaymentAttempt(rt, customerB, attempt.id)).rejects.toMatchObject({
      code: 'not_found',
    });

    // A redirect is not settlement: verify before the provider reports success keeps it pending.
    const pendingVerify = await verifyPaymentAttempt(rt, customerA, { id: attempt.id });
    expect(pendingVerify.decision).toBe('keep_pending');
    expect(pendingVerify.invoiceStatus).toBe('issued');

    dev.simulate(attempt.reference, 'success');
    await expect(verifyPaymentAttempt(rt, customerB, { id: attempt.id })).rejects.toMatchObject({
      code: 'not_found',
    });
    const settled = await verifyPaymentAttempt(rt, customerA, { id: attempt.id });
    expect(settled.decision).toBe('settle');
    expect(settled.invoiceStatus).toBe('paid');
    expect(settled.receiptNumber).toMatch(/^RCT-\d{4}-\d{4}$/);
    expect(settled.attempt.status).toBe('successful');
    expect(settled.attempt.feesKobo).not.toBeNull();

    const paid = await getInvoice(rt, customerA, invoice.id);
    expect(paid.status).toBe('paid');
    expect(paid.amountPaidKobo).toBe('15000000');
    expect(paid.balanceKobo).toBe('0');
    const [srInProgress] = await dbs.owner
      .select()
      .from(schema.serviceRequests)
      .where(eq(schema.serviceRequests.id, sr.id));
    expect(srInProgress!.status).toBe('in_progress');

    // A second verification after settlement changes nothing.
    const again = await verifyPaymentAttempt(rt, customerA, { id: attempt.id });
    expect(again.decision).toBe('no_change');
    expect(again.receiptNumber).toBe(settled.receiptNumber);
    expect(await countAllocationsForAttempt(dbs.owner, attempt.id)).toBe(1);
    expect(await countReceiptsForInvoice(dbs.owner, invoice.id)).toBe(1);

    const settlement = await journalByRef(dbs.owner, `payment_attempt:${attempt.id}:settled`);
    expect(settlement).not.toBeNull();
    const balance = await assertLedgerBalanced(dbs.owner);
    expect(balance.debitKobo).toBe(balance.creditKobo);
    expect(balance.unbalancedJournals).toBe(0);

    const transitions = await dbs.owner
      .select()
      .from(schema.engagementTransitions)
      .where(eq(schema.engagementTransitions.serviceRequestId, sr.id));
    expect(transitions.map((x) => x.toStatus)).toEqual([
      'inquiry',
      'triage',
      'quoted',
      'accepted',
      'awaiting_payment',
      'in_progress',
    ]);
    const outbox = await dbs.owner
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.aggregateId, attempt.id));
    expect(outbox.map((e) => e.eventType)).toContain('payment.settled');
  });
});
