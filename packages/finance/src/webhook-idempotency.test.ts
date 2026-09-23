import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@simplexd/db';
import { connectTestDatabases, type TestDatabases } from '@simplexd/db/testing';
import type { DevPaymentProvider } from '@simplexd/integrations/payments';
import type { FinanceActor } from './actor';
import { createInvoice, getInvoice } from './invoices';
import { createPaymentAttempt, verifyPaymentAttempt } from './payment-attempts';
import { processProviderEvent, receiveProviderWebhook } from './provider-events';
import { listReconciliationExceptions } from './reconciliation';
import { approveRefund, getRefund, requestRefund, submitRefund } from './refunds';
import type { FinanceRuntime } from './runtime';
import {
  assertLedgerBalanced,
  countAllocationsForAttempt,
  countReceiptsForInvoice,
  customerActor,
  devProviderRuntime,
  journalByRef,
  seedTenants,
  staffActor,
  type Tenants,
} from './testing/fixtures';

/**
 * Acceptance scenario 6: duplicate, delayed and reordered payment events do
 * not double-allocate money; invalid signatures, mismatched currencies and
 * amounts and uncertain refunds do not produce settled invoices or credits.
 */

let dbs: TestDatabases;
let t: Tenants;
let rt: FinanceRuntime;
let dev: DevPaymentProvider;
let customerA: FinanceActor;
let finance1: FinanceActor;
let finance2: FinanceActor;

async function issuedInvoice(amountKobo: string): Promise<string> {
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

async function pendingAttempt(amountKobo = '5000000') {
  const invoiceId = await issuedInvoice(amountKobo);
  const attempt = await createPaymentAttempt(rt, customerA, invoiceId, {});
  return { invoiceId, attempt };
}

function webhook(rawBody: string, signature: string) {
  return receiveProviderWebhook(rt, { rawBody, signatureHeader: signature, headers: { 'content-type': 'application/json', 'x-paystack-signature': signature } });
}

beforeAll(async () => {
  dbs = connectTestDatabases();
  t = await seedTenants(dbs.owner);
  ({ rt, dev } = devProviderRuntime(dbs.app));
  customerA = customerActor({ userId: t.userA, organizationId: t.orgA });
  finance1 = staffActor({ userId: t.financeUser1, roles: ['finance'] });
  finance2 = staffActor({ userId: t.financeUser2, roles: ['finance'] });
});

afterAll(async () => {
  await dbs.close();
});

describe('webhook intake and processing', () => {
  it('replayed charge.success settles once; a later verify is a no-op', async () => {
    const { invoiceId, attempt } = await pendingAttempt();
    dev.simulate(attempt.reference, 'success');
    const delivery = dev.buildWebhookEvent('charge.success', attempt.reference);

    const first = await webhook(delivery.rawBody, delivery.signature);
    expect(first).toMatchObject({ status: 200, duplicate: false });
    expect(first.jobId).not.toBeNull();
    const second = await webhook(delivery.rawBody, delivery.signature);
    expect(second).toMatchObject({ status: 200, duplicate: true, jobId: null, providerEventId: first.providerEventId });

    const processed = await processProviderEvent(rt, first.providerEventId!);
    expect(processed.actions[0]).toMatchObject({ kind: 'verify_and_settle' });
    expect(processed.actions[0]!.result).toContain('settle');
    // Re-running the job (worker retry) and a webhook-driven re-plan both stay idempotent.
    const rerun = await processProviderEvent(rt, first.providerEventId!);
    expect(rerun.actions[0]!.kind).toBe('ignore');

    const later = await verifyPaymentAttempt(rt, customerA, { id: attempt.id });
    expect(later.decision).toBe('no_change');
    expect(await countAllocationsForAttempt(dbs.owner, attempt.id)).toBe(1);
    expect(await countReceiptsForInvoice(dbs.owner, invoiceId)).toBe(1);
    expect((await getInvoice(rt, customerA, invoiceId)).status).toBe('paid');

    const events = await dbs.owner.select().from(schema.providerEvents).where(eq(schema.providerEvents.reference, attempt.reference));
    expect(events).toHaveLength(1);
    expect(events[0]!.processingStatus).toBe('processed');
  });

  it('a refund event arriving before charge.success is flagged, then the charge still settles exactly once', async () => {
    const { invoiceId, attempt } = await pendingAttempt();
    dev.simulate(attempt.reference, 'success');
    const early = JSON.stringify({
      event: 'refund.processed',
      data: { id: 4242, status: 'processed', transaction_reference: attempt.reference, refund_reference: 'TRF_early', amount: 5000000, currency: 'NGN', domain: 'test' },
    });
    const earlyReceipt = await webhook(early, dev.signWebhook(early));
    expect(earlyReceipt.status).toBe(200);
    const earlyProcessed = await processProviderEvent(rt, earlyReceipt.providerEventId!);
    expect(earlyProcessed.actions[0]!.kind).toBe('flag_for_reconciliation');

    const charge = dev.buildWebhookEvent('charge.success', attempt.reference);
    const chargeReceipt = await webhook(charge.rawBody, charge.signature);
    await processProviderEvent(rt, chargeReceipt.providerEventId!);
    // The customer's callback verify races the webhook: still one allocation.
    await verifyPaymentAttempt(rt, customerA, { id: attempt.id });
    expect(await countAllocationsForAttempt(dbs.owner, attempt.id)).toBe(1);
    expect(await countReceiptsForInvoice(dbs.owner, invoiceId)).toBe(1);
    const refunds = await dbs.owner.select().from(schema.refunds).where(eq(schema.refunds.paymentAttemptId, attempt.id));
    expect(refunds).toHaveLength(0);
    const exceptions = await listReconciliationExceptions(rt, finance1, { limit: 5 });
    expect(exceptions.some((e) => e.code === 'provider_event_flagged' && e.entityId === earlyReceipt.providerEventId)).toBe(true);
  });

  it('rejects an invalid signature with 401, records the event as unsigned and enqueues nothing', async () => {
    const { attempt } = await pendingAttempt();
    dev.simulate(attempt.reference, 'success');
    const delivery = dev.buildWebhookEvent('charge.success', attempt.reference);
    const forged = `${delivery.signature.slice(0, -4)}dead`;
    const receipt = await webhook(delivery.rawBody, forged);
    expect(receipt).toMatchObject({ status: 401, received: false, jobId: null, providerEventId: null });
    const rows = await dbs.owner.select().from(schema.providerEvents).where(and(eq(schema.providerEvents.signatureValid, false), like(schema.providerEvents.rawBody, `%${attempt.reference}%`)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.processingStatus).toBe('ignored');
    const jobs = await dbs.owner.select().from(schema.jobs).where(like(schema.jobs.dedupeKey, 'provider_event:%'));
    expect(jobs.some((j) => (j.payload as { reference?: string }).reference === attempt.reference)).toBe(false);
    expect(await countAllocationsForAttempt(dbs.owner, attempt.id)).toBe(0);
    const missing = await receiveProviderWebhook(rt, { rawBody: delivery.rawBody, signatureHeader: null, headers: { 'content-type': 'application/json' } });
    expect(missing.status).toBe(401);
  });

  it('an amount mismatch marks the attempt uncertain, opens an exception and leaves the invoice unpaid', async () => {
    const { invoiceId, attempt } = await pendingAttempt('5000000');
    dev.simulate(attempt.reference, 'success', { amountKobo: 6000000n });
    const result = await verifyPaymentAttempt(rt, customerA, { id: attempt.id });
    expect(result.decision).toBe('mismatch');
    expect(result.attempt.status).toBe('uncertain');
    expect(result.invoiceStatus).toBe('issued');
    expect(await countAllocationsForAttempt(dbs.owner, attempt.id)).toBe(0);
    expect(await journalByRef(dbs.owner, `payment_attempt:${attempt.id}:settled`)).toBeNull();
    expect((await getInvoice(rt, customerA, invoiceId)).amountPaidKobo).toBe('0');
    const exceptions = await listReconciliationExceptions(rt, finance1, { limit: 5 });
    expect(exceptions.some((e) => e.code === 'verification_mismatch' && e.entityId === attempt.id)).toBe(true);

    // The webhook path reaches the same conclusion and never settles either.
    const delivery = dev.buildWebhookEvent('charge.success', attempt.reference);
    const receipt = await webhook(delivery.rawBody, delivery.signature);
    const processed = await processProviderEvent(rt, receipt.providerEventId!);
    expect(processed.actions[0]!.result).toBe('mismatch');
    expect(await countAllocationsForAttempt(dbs.owner, attempt.id)).toBe(0);
  });

  it('a currency mismatch never settles', async () => {
    const { invoiceId, attempt } = await pendingAttempt('5000000');
    dev.simulate(attempt.reference, 'success', { currency: 'USD' });
    const result = await verifyPaymentAttempt(rt, customerA, { id: attempt.id });
    expect(result.decision).toBe('mismatch');
    expect(result.attempt.status).toBe('uncertain');
    expect(await countAllocationsForAttempt(dbs.owner, attempt.id)).toBe(0);
    expect((await getInvoice(rt, customerA, invoiceId)).status).toBe('issued');
  });

  it('failed and abandoned checkouts change the attempt only', async () => {
    const { invoiceId, attempt } = await pendingAttempt('5000000');
    dev.simulate(attempt.reference, 'failed');
    const failed = await verifyPaymentAttempt(rt, customerA, { id: attempt.id });
    expect(failed.decision).toBe('fail');
    expect(failed.attempt.status).toBe('failed');
    expect((await getInvoice(rt, customerA, invoiceId)).status).toBe('issued');
    expect(await countAllocationsForAttempt(dbs.owner, attempt.id)).toBe(0);
  });

  it('an uncertain refund never credits; only a processed refund settles, and stale events are ignored', async () => {
    const { attempt } = await pendingAttempt('5000000');
    dev.simulate(attempt.reference, 'success');
    await verifyPaymentAttempt(rt, customerA, { id: attempt.id });

    const requested = await requestRefund(rt, finance1, { paymentAttemptId: attempt.id, amountKobo: '2000000', reason: 'Scope reduced after site visit' });
    const approved = await approveRefund(rt, finance2, requested.id, {});
    expect(approved.status).toBe('approved');
    expect(await journalByRef(dbs.owner, `refund:${requested.id}:approved`)).not.toBeNull();

    const submitted = await submitRefund(rt, requested.id);
    expect(submitted.status).toBe('submitted');
    expect(submitted.providerStatus).toBe('pending');
    expect(await journalByRef(dbs.owner, `refund:${requested.id}:settled`)).toBeNull();
    // Submitting again reuses the stored idempotency key: the provider sees one refund.
    const resubmitted = await submitRefund(rt, requested.id);
    expect(resubmitted.status).toBe('submitted');
    const [refundRow] = await dbs.owner.select().from(schema.refunds).where(eq(schema.refunds.id, requested.id));
    const providerRefundId = refundRow!.providerReference!;

    dev.simulateRefund(providerRefundId, 'needs_attention');
    const attention = dev.buildWebhookEvent('refund.needs-attention', attempt.reference, { providerRefundId });
    const attentionReceipt = await webhook(attention.rawBody, attention.signature);
    await processProviderEvent(rt, attentionReceipt.providerEventId!);
    let current = await getRefund(rt, finance1, requested.id);
    expect(current.status).toBe('pending');
    expect(current.settledAt).toBeNull();
    expect(await journalByRef(dbs.owner, `refund:${requested.id}:settled`)).toBeNull();
    const exceptions = await listReconciliationExceptions(rt, finance1, { limit: 5 });
    expect(exceptions.some((e) => e.code === 'refund_needs_attention' && e.entityId === requested.id)).toBe(true);

    dev.simulateRefund(providerRefundId, 'processed');
    const processedEvent = dev.buildWebhookEvent('refund.processed', attempt.reference, { providerRefundId });
    const processedReceipt = await webhook(processedEvent.rawBody, processedEvent.signature);
    await processProviderEvent(rt, processedReceipt.providerEventId!);
    current = await getRefund(rt, finance1, requested.id);
    expect(current.status).toBe('settled');
    expect(current.settledAt).not.toBeNull();
    expect(await journalByRef(dbs.owner, `refund:${requested.id}:settled`)).not.toBeNull();

    // Reordered: a stale refund.pending after settlement is ignored.
    dev.simulateRefund(providerRefundId, 'pending');
    const stale = dev.buildWebhookEvent('refund.pending', attempt.reference, { providerRefundId });
    const staleReceipt = await webhook(stale.rawBody, stale.signature);
    const staleProcessed = await processProviderEvent(rt, staleReceipt.providerEventId!);
    expect(staleProcessed.actions[0]!.kind).toBe('ignore');
    expect((await getRefund(rt, finance1, requested.id)).status).toBe('settled');

    const balance = await assertLedgerBalanced(dbs.owner);
    expect(balance.debitKobo).toBe(balance.creditKobo);
    expect(balance.unbalancedJournals).toBe(0);
  });
});
