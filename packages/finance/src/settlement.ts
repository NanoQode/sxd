import { and, eq } from 'drizzle-orm';
import { ApiError } from '@simplexd/contracts';
import { schema, withActor, type Transaction } from '@simplexd/db';
import { gatewayPaymentSettled, planAllocation, reverse } from '@simplexd/domain/ledger';
import { evaluateTransition, paymentAttemptMachine } from '@simplexd/domain/workflow';
import { matchVerification, type VerifyResult } from '@simplexd/integrations/payments';
import { systemFinanceActor, type FinanceActor } from './actor';
import { emitEvent, recordAudit } from './audit';
import { transitionEngagement } from './engagements/transitions';
import { findJournalByRef, isUniqueViolation, postJournal } from './journal';
import { nextDocumentNumber } from './numbering';
import { addReconciliationException } from './reconciliation-exceptions';
import type { FinanceRuntime } from './runtime';

export type PaymentAttemptRow = typeof schema.paymentAttempts.$inferSelect;

export interface SettleInput {
  attemptId: string;
  verification: VerifyResult;
  /** Where the verification came from, recorded in the audit trail. */
  source: 'verify' | 'callback' | 'webhook' | 'reconcile';
  actorUserId?: string | null;
  correlationId?: string;
}

export interface SettleResult {
  settled: boolean;
  alreadySettled: boolean;
  allocationId: string | null;
  receiptNumber: string | null;
  invoiceStatus: (typeof schema.invoices.$inferSelect)['status'];
  attempt: PaymentAttemptRow;
}

export function attemptDedupeKey(attemptId: string): string {
  return `payment_attempt:${attemptId}`;
}

/**
 * THE settlement path. Every route (customer verify, callback, webhook job,
 * reconciliation) ends here. Under the system context, in one transaction:
 * lock the attempt, refuse if an allocation already exists, re-check the
 * provider truth against the locked record, post the `gatewayPaymentSettled`
 * journal, insert the allocation whose unique dedupe key makes replays
 * impossible, update the invoice through the invoice machine, issue the
 * receipt once, mark the attempt successful and append audit + outbox.
 */
export async function settleAttempt(rt: FinanceRuntime, input: SettleInput): Promise<SettleResult> {
  const system: FinanceActor = systemFinanceActor(input.correlationId);
  if (input.actorUserId) system.actor = { ...system.actor, userId: input.actorUserId };
  return withActor(rt.db, system.ctx, async (tx) => {
    const [attempt] = await tx
      .select()
      .from(schema.paymentAttempts)
      .where(eq(schema.paymentAttempts.id, input.attemptId))
      .for('update');
    if (!attempt) throw new ApiError('not_found', 'payment attempt not found');
    const [existingAllocation] = await tx
      .select({ id: schema.allocations.id })
      .from(schema.allocations)
      .where(eq(schema.allocations.dedupeKey, attemptDedupeKey(attempt.id)));
    if (existingAllocation || attempt.status === 'successful') {
      const [inv] = await tx.select({ status: schema.invoices.status }).from(schema.invoices).where(eq(schema.invoices.id, attempt.invoiceId));
      const [receipt] = existingAllocation
        ? await tx.select({ number: schema.receipts.number }).from(schema.receipts).where(eq(schema.receipts.allocationId, existingAllocation.id))
        : [];
      return {
        settled: false,
        alreadySettled: true,
        allocationId: existingAllocation?.id ?? null,
        receiptNumber: receipt?.number ?? null,
        invoiceStatus: inv?.status ?? 'paid',
        attempt,
      };
    }
    const outcome = matchVerification({
      attempt: { reference: attempt.reference, amountKobo: attempt.amountKobo, currency: attempt.currency, status: attempt.status },
      verification: input.verification,
    });
    if (outcome.decision !== 'settle') {
      throw new ApiError('payment_verification_failed', 'the provider record does not match this payment attempt; nothing was allocated', {
        details: { decision: outcome.decision, reasons: outcome.reasons },
      });
    }
    if (input.verification.environment !== 'unknown' && input.verification.environment !== attempt.environment) {
      throw new ApiError('payment_verification_failed', 'provider environment does not match the attempt', {
        details: { expected: attempt.environment, reported: input.verification.environment },
      });
    }
    const transition = evaluateTransition(paymentAttemptMachine, { from: attempt.status, to: 'successful', actor: 'system' });
    if (!transition.ok) throw new ApiError('invalid_transition', transition.message);

    const [invoice] = await tx.select().from(schema.invoices).where(eq(schema.invoices.id, attempt.invoiceId)).for('update');
    if (!invoice) throw new ApiError('not_found', 'invoice not found');
    const plan = planAllocation({ invoice, amountKobo: attempt.amountKobo });
    const now = rt.now();

    const journal = await postJournal(
      tx,
      gatewayPaymentSettled({
        attempt: {
          id: attempt.id,
          reference: attempt.reference,
          invoiceId: attempt.invoiceId,
          organizationId: attempt.organizationId,
          currency: attempt.currency,
          amountKobo: attempt.amountKobo,
          feesKobo: input.verification.feesKobo,
        },
        allocatedKobo: plan.allocatedKobo,
        overpaymentKobo: plan.overpaymentKobo,
        isRentOnBehalfOfOwner: invoice.isRentOnBehalfOfOwner,
        estateSegment: invoice.estateSegment,
      }),
      { postedBy: input.actorUserId ?? null },
    );
    let allocationId: string;
    try {
      const [allocation] = await tx
        .insert(schema.allocations)
        .values({
          organizationId: attempt.organizationId,
          invoiceId: attempt.invoiceId,
          paymentAttemptId: attempt.id,
          amountKobo: attempt.amountKobo,
          currency: attempt.currency,
          dedupeKey: attemptDedupeKey(attempt.id),
          journalId: journal.id,
          allocatedBy: input.actorUserId ?? 'system',
        })
        .returning({ id: schema.allocations.id });
      allocationId = allocation!.id;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ApiError('conflict', 'this payment attempt was already allocated');
      throw err;
    }
    const [updatedInvoice] = await tx
      .update(schema.invoices)
      .set({
        amountPaidKobo: plan.newAmountPaidKobo,
        status: plan.newStatus,
        paidAt: plan.newStatus === 'paid' ? now : invoice.paidAt,
        version: invoice.version + 1,
      })
      .where(and(eq(schema.invoices.id, invoice.id), eq(schema.invoices.version, invoice.version)))
      .returning();
    if (!updatedInvoice) throw new ApiError('version_conflict', 'invoice changed during settlement');

    let receiptNumber: string | null = null;
    if (plan.receiptRequired) {
      receiptNumber = await nextDocumentNumber(tx, 'receipts', now);
      await tx.insert(schema.receipts).values({
        organizationId: attempt.organizationId,
        invoiceId: attempt.invoiceId,
        allocationId,
        number: receiptNumber,
        amountKobo: plan.allocatedKobo,
      });
    }
    const [updatedAttempt] = await tx
      .update(schema.paymentAttempts)
      .set({
        status: 'successful',
        providerReference: input.verification.providerReference ?? attempt.providerReference,
        channel: input.verification.channel ?? attempt.channel,
        feesKobo: input.verification.feesKobo,
        providerResponseSanitized: input.verification.raw,
        verifiedAt: now,
        settledAt: now,
        failureReason: null,
        version: attempt.version + 1,
      })
      .where(eq(schema.paymentAttempts.id, attempt.id))
      .returning();

    if (plan.newStatus === 'paid' && invoice.serviceRequestId) {
      const [sr] = await tx.select().from(schema.serviceRequests).where(eq(schema.serviceRequests.id, invoice.serviceRequestId)).for('update');
      if (sr && sr.status === 'awaiting_payment') {
        await transitionEngagement(tx, system, {
          sr,
          to: 'in_progress',
          actorKind: 'system',
          metadata: { invoiceId: invoice.id, paymentAttemptId: attempt.id, receiptNumber, billingConsequence: 'verified_payment' },
        });
      }
    }
    await emitEvent(tx, system, {
      eventType: 'payment.settled',
      aggregateType: 'payment_attempt',
      aggregateId: attempt.id,
      organizationId: attempt.organizationId,
      payload: {
        paymentAttemptId: attempt.id,
        invoiceId: invoice.id,
        invoiceNumber: updatedInvoice.number,
        customerUserId: invoice.customerUserId,
        amountKobo: attempt.amountKobo,
        currency: attempt.currency,
        allocatedKobo: plan.allocatedKobo,
        overpaymentKobo: plan.overpaymentKobo,
        receiptNumber,
        source: input.source,
      },
    });
    await emitEvent(tx, system, {
      eventType: plan.newStatus === 'paid' ? 'invoice.paid' : 'invoice.partially_paid',
      aggregateType: 'invoice',
      aggregateId: invoice.id,
      organizationId: attempt.organizationId,
      payload: { invoiceId: invoice.id, invoiceNumber: updatedInvoice.number, status: plan.newStatus, amountPaidKobo: plan.newAmountPaidKobo },
    });
    await recordAudit(tx, system, {
      action: 'payment_attempt.settled',
      entityType: 'payment_attempt',
      entityId: attempt.id,
      organizationId: attempt.organizationId,
      before: { status: attempt.status },
      after: {
        status: 'successful',
        allocationId,
        journalId: journal.id,
        receiptNumber,
        invoiceStatus: plan.newStatus,
        source: input.source,
        providerStatus: input.verification.providerStatus,
      },
      actorType: input.source === 'webhook' ? 'webhook' : input.actorUserId ? 'user' : 'job',
    });
    return {
      settled: true,
      alreadySettled: false,
      allocationId,
      receiptNumber,
      invoiceStatus: plan.newStatus,
      attempt: updatedAttempt!,
    };
  });
}

/** Attempt status changes that move no money (failed, abandoned, pending, uncertain). */
export async function recordAttemptOutcome(
  rt: FinanceRuntime,
  input: {
    attemptId: string;
    status: 'pending' | 'failed' | 'abandoned' | 'uncertain';
    verification?: VerifyResult | null;
    reasons: string[];
    exceptionCode?: string;
    source: SettleInput['source'];
    actorUserId?: string | null;
    correlationId?: string;
  },
): Promise<PaymentAttemptRow> {
  const system = systemFinanceActor(input.correlationId);
  return withActor(rt.db, system.ctx, async (tx) => {
    const [attempt] = await tx.select().from(schema.paymentAttempts).where(eq(schema.paymentAttempts.id, input.attemptId)).for('update');
    if (!attempt) throw new ApiError('not_found', 'payment attempt not found');
    const now = rt.now();
    if (attempt.status === input.status) {
      const [same] = await tx
        .update(schema.paymentAttempts)
        .set({ verifiedAt: now, lastReconciledAt: now, providerResponseSanitized: input.verification?.raw ?? attempt.providerResponseSanitized })
        .where(eq(schema.paymentAttempts.id, attempt.id))
        .returning();
      if (input.exceptionCode) await flagAttempt(tx, attempt, input.exceptionCode, input.reasons, now);
      return same!;
    }
    const transition = evaluateTransition(paymentAttemptMachine, { from: attempt.status, to: input.status, actor: 'system' });
    if (!transition.ok) {
      // Terminal or already settled attempts keep their state; the disagreement is a reconciliation matter.
      await flagAttempt(tx, attempt, input.exceptionCode ?? 'status_conflict', [transition.message, ...input.reasons], now);
      return attempt;
    }
    const [updated] = await tx
      .update(schema.paymentAttempts)
      .set({
        status: input.status,
        failureReason: input.status === 'pending' ? null : input.reasons.join('; ').slice(0, 1000),
        providerResponseSanitized: input.verification?.raw ?? attempt.providerResponseSanitized,
        providerReference: input.verification?.providerReference ?? attempt.providerReference,
        verifiedAt: now,
        lastReconciledAt: now,
        version: attempt.version + 1,
      })
      .where(eq(schema.paymentAttempts.id, attempt.id))
      .returning();
    if (input.exceptionCode) await flagAttempt(tx, attempt, input.exceptionCode, input.reasons, now);
    await recordAudit(tx, system, {
      action: `payment_attempt.${input.status}`,
      entityType: 'payment_attempt',
      entityId: attempt.id,
      organizationId: attempt.organizationId,
      before: { status: attempt.status },
      after: { status: input.status, reasons: input.reasons, source: input.source },
      actorType: input.source === 'webhook' ? 'webhook' : input.actorUserId ? 'user' : 'job',
    });
    return updated!;
  });
}

async function flagAttempt(tx: Transaction, attempt: PaymentAttemptRow, code: string, reasons: string[], now: Date): Promise<void> {
  await addReconciliationException(
    tx,
    { code, message: `${attempt.reference}: ${reasons.join('; ')}`, entityType: 'payment_attempt', entityId: attempt.id },
    now,
  );
}

/**
 * Provider reports a settled charge as reversed: the attempt becomes
 * `reversed`, the settlement journal is reversed and finance gets an
 * exception. The invoice is left for finance (credit note or reopen per
 * policy); history is never edited.
 */
export async function reverseSettledAttempt(
  rt: FinanceRuntime,
  input: { attemptId: string; verification: VerifyResult; source: SettleInput['source']; correlationId?: string },
): Promise<PaymentAttemptRow> {
  const system = systemFinanceActor(input.correlationId);
  return withActor(rt.db, system.ctx, async (tx) => {
    const [attempt] = await tx.select().from(schema.paymentAttempts).where(eq(schema.paymentAttempts.id, input.attemptId)).for('update');
    if (!attempt) throw new ApiError('not_found', 'payment attempt not found');
    if (attempt.status === 'reversed') return attempt;
    const transition = evaluateTransition(paymentAttemptMachine, { from: attempt.status, to: 'reversed', actor: 'system' });
    if (!transition.ok) throw new ApiError('invalid_transition', transition.message);
    const now = rt.now();
    const [invoice] = await tx.select().from(schema.invoices).where(eq(schema.invoices.id, attempt.invoiceId));
    const [allocation] = await tx.select().from(schema.allocations).where(eq(schema.allocations.dedupeKey, attemptDedupeKey(attempt.id)));
    let journalId: string | null = null;
    const original = await findJournalByRef(tx, `payment_attempt:${attempt.id}:settled`);
    if (original && invoice && allocation) {
      const draft = reverse(
        gatewayPaymentSettled({
          attempt: {
            id: attempt.id,
            reference: attempt.reference,
            invoiceId: attempt.invoiceId,
            organizationId: attempt.organizationId,
            currency: attempt.currency,
            amountKobo: attempt.amountKobo,
            feesKobo: attempt.feesKobo,
          },
          allocatedKobo: allocation.amountKobo,
          overpaymentKobo: attempt.amountKobo - allocation.amountKobo,
          isRentOnBehalfOfOwner: invoice.isRentOnBehalfOfOwner,
          estateSegment: invoice.estateSegment,
        }),
        `payment_attempt:${attempt.id}:reversed`,
        'provider reported the charge as reversed',
      );
      journalId = (await postJournal(tx, draft)).id;
    }
    const [updated] = await tx
      .update(schema.paymentAttempts)
      .set({
        status: 'reversed',
        failureReason: 'provider reported the settled charge as reversed',
        providerResponseSanitized: input.verification.raw,
        verifiedAt: now,
        lastReconciledAt: now,
        version: attempt.version + 1,
      })
      .where(eq(schema.paymentAttempts.id, attempt.id))
      .returning();
    await addReconciliationException(
      tx,
      {
        code: 'payment_reversed',
        message: `${attempt.reference}: settled payment reversed by the provider; review invoice ${invoice?.number ?? attempt.invoiceId}`,
        entityType: 'payment_attempt',
        entityId: attempt.id,
      },
      now,
    );
    await emitEvent(tx, system, {
      eventType: 'payment.reversed',
      aggregateType: 'payment_attempt',
      aggregateId: attempt.id,
      organizationId: attempt.organizationId,
      payload: { paymentAttemptId: attempt.id, invoiceId: attempt.invoiceId, amountKobo: attempt.amountKobo },
    });
    await recordAudit(tx, system, {
      action: 'payment_attempt.reversed',
      entityType: 'payment_attempt',
      entityId: attempt.id,
      organizationId: attempt.organizationId,
      before: { status: attempt.status },
      after: { status: 'reversed', journalId, source: input.source },
      actorType: input.source === 'webhook' ? 'webhook' : 'job',
    });
    return updated!;
  });
}
