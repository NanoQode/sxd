import { randomUUID } from 'node:crypto';
import { and, eq, or, sql } from 'drizzle-orm';
import { ApiError, type RefundDto, type RefundRequest } from '@simplexd/contracts';
import { schema, withActor, type Transaction } from '@simplexd/db';
import {
  refundApproved,
  refundSettled,
  reverse,
  type OriginalRecognition,
} from '@simplexd/domain/ledger';
import { evaluateTransition, refundMachine, type RefundState } from '@simplexd/domain/workflow';
import {
  ProviderError,
  type ParsedProviderEvent,
  type ProviderRefundStatus,
  type RefundResult,
} from '@simplexd/integrations/payments';
import {
  assertStaff,
  assertStaffOrOrg,
  elevated,
  requireUserId,
  systemFinanceActor,
  type FinanceActor,
} from './actor';
import { emitEvent, recordAudit } from './audit';
import { findJournalByRef, postJournal } from './journal';
import { iso } from './money';
import { providerForAttempt } from './payment-attempts';
import { addReconciliationException } from './reconciliation-exceptions';
import type { FinanceRuntime } from './runtime';

export type RefundRow = typeof schema.refunds.$inferSelect;

export function toRefundDto(r: RefundRow): RefundDto {
  return {
    id: r.id,
    paymentAttemptId: r.paymentAttemptId,
    invoiceId: r.invoiceId,
    organizationId: r.organizationId,
    amountKobo: r.amountKobo.toString(),
    currency: r.currency,
    status: r.status,
    reason: r.reason,
    requestedBy: r.requestedBy,
    approvedBy: r.approvedBy,
    approvedAt: iso(r.approvedAt),
    submittedAt: iso(r.submittedAt),
    settledAt: iso(r.settledAt),
    failureReason: r.failureReason,
    providerStatus: r.providerStatus,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

async function loadRefundForUpdate(tx: Transaction, id: string): Promise<RefundRow> {
  const [row] = await tx
    .select()
    .from(schema.refunds)
    .where(eq(schema.refunds.id, id))
    .for('update');
  if (!row) throw new ApiError('not_found', 'refund not found');
  return row;
}

function recognitionSourceFor(invoice: typeof schema.invoices.$inferSelect): OriginalRecognition {
  if (invoice.isRentOnBehalfOfOwner) return 'rent_payable';
  if (invoice.kind === 'deposit') return 'unearned';
  return 'revenue';
}

/**
 * Finance (`finance.refunds.request`) or the customer (creates a request for
 * finance to review) asks for a refund of a settled attempt. Nothing moves
 * until a different approver with step-up authentication approves it.
 */
export async function requestRefund(
  rt: FinanceRuntime,
  fa: FinanceActor,
  input: RefundRequest,
): Promise<RefundDto> {
  const userId = requireUserId(fa);
  return withActor(rt.db, fa.ctx, async (tx) => {
    const [attempt] = await tx
      .select()
      .from(schema.paymentAttempts)
      .where(eq(schema.paymentAttempts.id, input.paymentAttemptId))
      .for('update');
    if (!attempt) throw new ApiError('not_found', 'payment attempt not found');
    assertStaffOrOrg(fa, 'finance.refunds.request', 'org.invoices.view', {
      type: 'invoice',
      id: attempt.invoiceId,
      organizationId: attempt.organizationId,
    });
    if (attempt.status !== 'successful') {
      throw new ApiError(
        'invalid_transition',
        `only settled payments can be refunded (attempt is ${attempt.status})`,
      );
    }
    const amountKobo = input.amountKobo ? BigInt(input.amountKobo) : attempt.amountKobo;
    if (amountKobo <= 0n || amountKobo > attempt.amountKobo) {
      throw new ApiError(
        'validation_failed',
        'refund amount must be positive and no more than the payment',
      );
    }
    const [sum] = await tx
      .select({ refunded: sql<string>`coalesce(sum(${schema.refunds.amountKobo}), 0)::text` })
      .from(schema.refunds)
      .where(
        and(
          eq(schema.refunds.paymentAttemptId, attempt.id),
          sql`${schema.refunds.status} not in ('rejected','failed')`,
        ),
      );
    const refunded = sum?.refunded ?? '0';
    if (BigInt(refunded) + amountKobo > attempt.amountKobo) {
      throw new ApiError('validation_failed', 'refunds requested exceed the amount paid', {
        details: { alreadyRequestedKobo: refunded },
      });
    }
    const [refund] = await tx
      .insert(schema.refunds)
      .values({
        organizationId: attempt.organizationId,
        paymentAttemptId: attempt.id,
        invoiceId: attempt.invoiceId,
        amountKobo,
        currency: attempt.currency,
        status: 'requested',
        reason: input.reason,
        requestedBy: userId,
      })
      .returning();
    await emitEvent(tx, fa, {
      eventType: 'refund.requested',
      aggregateType: 'refund',
      aggregateId: refund!.id,
      organizationId: attempt.organizationId,
      payload: {
        refundId: refund!.id,
        paymentAttemptId: attempt.id,
        invoiceId: attempt.invoiceId,
        amountKobo,
        requestedBy: userId,
      },
    });
    await recordAudit(tx, fa, {
      action: 'refund.requested',
      entityType: 'refund',
      entityId: refund!.id,
      organizationId: attempt.organizationId,
      after: { amountKobo, paymentAttemptId: attempt.id },
      reason: input.reason,
    });
    return toRefundDto(refund!);
  });
}

/**
 * Approval (`finance.refunds.approve`, MFA, approver ≠ requester): posts the
 * `refundApproved` liability and emits `refund.approved`, which the outbox
 * routes to `payments.submit_refund`.
 */
export async function approveRefund(
  rt: FinanceRuntime,
  fa: FinanceActor,
  refundId: string,
  input: { reason?: string },
): Promise<RefundDto> {
  const userId = requireUserId(fa);
  return withActor(rt.db, fa.ctx, async (tx) => {
    const refund = await loadRefundForUpdate(tx, refundId);
    assertStaff(fa, 'finance.refunds.approve', {
      type: 'refund',
      id: refund.id,
      organizationId: refund.organizationId,
      createdBy: refund.requestedBy,
    });
    if (refund.requestedBy === userId) {
      throw new ApiError(
        'forbidden',
        'a refund must be approved by someone other than the requester',
        { details: { code: 'separation_of_duties' } },
      );
    }
    const transition = evaluateTransition(refundMachine, {
      from: refund.status,
      to: 'approved',
      actor: 'staff',
      reason: input.reason ?? null,
    });
    if (!transition.ok) throw new ApiError('invalid_transition', transition.message);
    const [invoice] = await tx
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.id, refund.invoiceId));
    if (!invoice) throw new ApiError('not_found', 'invoice not found');
    const now = rt.now();
    const idempotencyKey =
      refund.idempotencyKey ?? `refund:${refund.id}:${randomUUID().slice(0, 8)}`;
    const journal = await elevated(tx, fa, () =>
      postJournal(
        tx,
        refundApproved({
          refund: {
            id: refund.id,
            invoiceId: refund.invoiceId,
            organizationId: refund.organizationId,
            currency: refund.currency,
            amountKobo: refund.amountKobo,
            status: 'approved',
          },
          source: recognitionSourceFor(invoice),
          estateSegment: invoice.estateSegment,
        }),
        { postedBy: userId },
      ),
    );
    const [updated] = await tx
      .update(schema.refunds)
      .set({
        status: 'approved',
        approvedBy: userId,
        approvedAt: now,
        journalId: journal.id,
        idempotencyKey,
        version: refund.version + 1,
      })
      .where(eq(schema.refunds.id, refund.id))
      .returning();
    await emitEvent(tx, fa, {
      eventType: 'refund.approved',
      aggregateType: 'refund',
      aggregateId: refund.id,
      organizationId: refund.organizationId,
      payload: {
        refundId: refund.id,
        paymentAttemptId: refund.paymentAttemptId,
        amountKobo: refund.amountKobo,
        approvedBy: userId,
      },
    });
    await recordAudit(tx, fa, {
      action: 'refund.approved',
      entityType: 'refund',
      entityId: refund.id,
      organizationId: refund.organizationId,
      before: { status: refund.status },
      after: { status: 'approved', journalId: journal.id, approvedBy: userId },
      reason: input.reason ?? null,
    });
    return toRefundDto(updated!);
  });
}

export async function rejectRefund(
  rt: FinanceRuntime,
  fa: FinanceActor,
  refundId: string,
  input: { reason?: string },
): Promise<RefundDto> {
  const userId = requireUserId(fa);
  return withActor(rt.db, fa.ctx, async (tx) => {
    const refund = await loadRefundForUpdate(tx, refundId);
    assertStaff(fa, 'finance.refunds.approve', {
      type: 'refund',
      id: refund.id,
      organizationId: refund.organizationId,
      createdBy: refund.requestedBy,
    });
    const transition = evaluateTransition(refundMachine, {
      from: refund.status,
      to: 'rejected',
      actor: 'staff',
      reason: input.reason ?? null,
    });
    if (!transition.ok) throw new ApiError('invalid_transition', transition.message);
    const [updated] = await tx
      .update(schema.refunds)
      .set({
        status: 'rejected',
        approvedBy: userId,
        approvedAt: rt.now(),
        failureReason: input.reason ?? null,
        version: refund.version + 1,
      })
      .where(eq(schema.refunds.id, refund.id))
      .returning();
    await recordAudit(tx, fa, {
      action: 'refund.rejected',
      entityType: 'refund',
      entityId: refund.id,
      organizationId: refund.organizationId,
      before: { status: refund.status },
      after: { status: 'rejected' },
      reason: input.reason ?? null,
    });
    return toRefundDto(updated!);
  });
}

export async function getRefund(
  rt: FinanceRuntime,
  fa: FinanceActor,
  refundId: string,
): Promise<RefundDto> {
  return withActor(rt.db, fa.ctx, async (tx) => {
    const [refund] = await tx.select().from(schema.refunds).where(eq(schema.refunds.id, refundId));
    if (!refund) throw new ApiError('not_found', 'refund not found');
    assertStaffOrOrg(fa, 'finance.read', 'org.invoices.view', {
      type: 'invoice',
      id: refund.invoiceId,
      organizationId: refund.organizationId,
    });
    return toRefundDto(refund);
  });
}

/**
 * Worker: sends an approved refund to the provider. The idempotency key is
 * stored on the record before the call and the same key is never used for a
 * second `createRefund`; a timed-out submission is reconciled with
 * `getRefund` before any retry. Submission alone never settles.
 */
export async function submitRefund(
  rt: FinanceRuntime,
  refundId: string,
  options: { correlationId?: string } = {},
): Promise<RefundDto> {
  const system = systemFinanceActor(options.correlationId);
  const prepared = await withActor(rt.db, system.ctx, async (tx) => {
    const refund = await loadRefundForUpdate(tx, refundId);
    if (refund.status !== 'approved') return { refund, attempt: null };
    const [attempt] = await tx
      .select()
      .from(schema.paymentAttempts)
      .where(eq(schema.paymentAttempts.id, refund.paymentAttemptId));
    if (!attempt) throw new ApiError('not_found', 'payment attempt not found');
    const key = refund.idempotencyKey ?? `refund:${refund.id}:${randomUUID().slice(0, 8)}`;
    if (!refund.idempotencyKey) {
      await tx
        .update(schema.refunds)
        .set({ idempotencyKey: key })
        .where(eq(schema.refunds.id, refund.id));
    }
    return { refund: { ...refund, idempotencyKey: key }, attempt };
  });
  if (!prepared.attempt) return toRefundDto(prepared.refund);
  const { refund, attempt } = prepared;
  const resolved = await providerForAttempt(rt, attempt);
  let result: RefundResult;
  try {
    if (refund.providerReference) {
      // A previous submission recorded a provider id but did not finish: reconcile instead of re-submitting.
      result = await resolved.provider.getRefund(refund.providerReference);
    } else {
      result = await resolved.provider.createRefund({
        providerReference: attempt.providerReference,
        reference: attempt.reference,
        amountKobo: refund.amountKobo,
        currency: refund.currency,
        reason: refund.reason.slice(0, 200),
        idempotencyKey: refund.idempotencyKey!,
      });
    }
  } catch (err) {
    const message = err instanceof ProviderError ? err.message : 'refund submission failed';
    await withActor(rt.db, system.ctx, async (tx) => {
      await addReconciliationException(
        tx,
        {
          code: 'refund_submission_failed',
          message: `refund ${refund.id}: ${message}`,
          entityType: 'refund',
          entityId: refund.id,
        },
        rt.now(),
      );
    });
    throw err;
  }
  return withActor(rt.db, system.ctx, async (tx) => {
    const current = await loadRefundForUpdate(tx, refundId);
    const now = rt.now();
    const [submitted] = await tx
      .update(schema.refunds)
      .set({
        status: current.status === 'approved' ? 'submitted' : current.status,
        submittedAt: current.submittedAt ?? now,
        providerReference: result.providerRefundId,
        providerStatus: result.status,
        version: current.version + 1,
      })
      .where(eq(schema.refunds.id, current.id))
      .returning();
    await recordAudit(tx, system, {
      action: 'refund.submitted',
      entityType: 'refund',
      entityId: current.id,
      organizationId: current.organizationId,
      before: { status: current.status },
      after: {
        status: submitted!.status,
        providerRefundId: result.providerRefundId,
        providerStatus: result.status,
      },
      actorType: 'job',
    });
    return submitted!;
  }).then(async (row) => {
    // The provider may already report a state beyond "pending" (processed or failed).
    if (result.status !== 'pending') {
      const updated = await applyProviderRefundOutcome(rt, row.id, result.status, {
        correlationId: options.correlationId,
        via: 'submit',
      });
      return toRefundDto(updated ?? row);
    }
    return toRefundDto(row);
  });
}

const REFUND_TARGET: Record<ProviderRefundStatus, RefundState> = {
  pending: 'pending',
  processing: 'pending',
  processed: 'settled',
  failed: 'failed',
  needs_attention: 'pending',
};

/**
 * Applies what the provider reports (webhook or poll). `processed` posts the
 * settlement journal; `failed` reverses the approval liability and opens an
 * exception; anything else keeps the refund pending. An uncertain or
 * pending refund never credits the customer.
 */
export async function applyProviderRefundOutcome(
  rt: FinanceRuntime,
  refundId: string,
  providerStatus: ProviderRefundStatus,
  options: { correlationId?: string; via: 'webhook' | 'poll' | 'submit' },
): Promise<RefundRow | null> {
  const system = systemFinanceActor(options.correlationId);
  return withActor(rt.db, system.ctx, async (tx) => {
    const refund = await loadRefundForUpdate(tx, refundId);
    const target = REFUND_TARGET[providerStatus];
    const now = rt.now();
    if (providerStatus === 'needs_attention') {
      await addReconciliationException(
        tx,
        {
          code: 'refund_needs_attention',
          message: `refund ${refund.id}: provider needs customer bank details`,
          entityType: 'refund',
          entityId: refund.id,
        },
        now,
      );
    }
    if (refund.status === target) {
      await tx
        .update(schema.refunds)
        .set({ providerStatus })
        .where(eq(schema.refunds.id, refund.id));
      return { ...refund, providerStatus };
    }
    const transition = evaluateTransition(refundMachine, {
      from: refund.status,
      to: target,
      actor: 'system',
      reason: `provider reported ${providerStatus}`,
    });
    if (!transition.ok) {
      await addReconciliationException(
        tx,
        {
          code: 'refund_status_conflict',
          message: `refund ${refund.id}: provider reports ${providerStatus} but record is ${refund.status}`,
          entityType: 'refund',
          entityId: refund.id,
        },
        now,
      );
      return refund;
    }
    const patch: Partial<typeof schema.refunds.$inferInsert> = {
      status: target,
      providerStatus,
      version: refund.version + 1,
    };
    if (target === 'settled') {
      const journal = await postJournal(
        tx,
        refundSettled({
          refund: {
            id: refund.id,
            organizationId: refund.organizationId,
            currency: refund.currency,
            amountKobo: refund.amountKobo,
            status: refund.status,
          },
          providerStatus: 'processed',
        }),
      );
      patch.settlementJournalId = journal.id;
      patch.settledAt = now;
    }
    if (target === 'failed') {
      patch.failureReason = `provider reported ${providerStatus}`;
      const original = await findJournalByRef(tx, `refund:${refund.id}:approved`);
      if (original) {
        const [invoice] = await tx
          .select()
          .from(schema.invoices)
          .where(eq(schema.invoices.id, refund.invoiceId));
        const draft = reverse(
          refundApproved({
            refund: {
              id: refund.id,
              invoiceId: refund.invoiceId,
              organizationId: refund.organizationId,
              currency: refund.currency,
              amountKobo: refund.amountKobo,
              status: 'approved',
            },
            source: invoice ? recognitionSourceFor(invoice) : 'revenue',
            estateSegment: invoice?.estateSegment ?? null,
          }),
          `refund:${refund.id}:failed`,
          'provider reported the refund as failed',
        );
        await postJournal(tx, draft);
      }
      await addReconciliationException(
        tx,
        {
          code: 'refund_failed',
          message: `refund ${refund.id} failed at the provider; liability reversed, review before retry`,
          entityType: 'refund',
          entityId: refund.id,
        },
        now,
      );
    }
    const [updated] = await tx
      .update(schema.refunds)
      .set(patch)
      .where(eq(schema.refunds.id, refund.id))
      .returning();
    await emitEvent(tx, system, {
      eventType: `refund.${target}`,
      aggregateType: 'refund',
      aggregateId: refund.id,
      organizationId: refund.organizationId,
      payload: {
        refundId: refund.id,
        invoiceId: refund.invoiceId,
        amountKobo: refund.amountKobo,
        providerStatus,
        via: options.via,
      },
    });
    await recordAudit(tx, system, {
      action: `refund.${target}`,
      entityType: 'refund',
      entityId: refund.id,
      organizationId: refund.organizationId,
      before: { status: refund.status },
      after: { status: target, providerStatus, via: options.via },
      actorType: options.via === 'webhook' ? 'webhook' : 'job',
    });
    return updated!;
  });
}

/** Matches a refund webhook to our record by provider refund id, then by attempt reference. */
export async function findRefundForEvent(
  tx: Transaction,
  event: ParsedProviderEvent,
  attemptId: string | null,
): Promise<RefundRow | null> {
  const conditions = [];
  if (event.providerRefundId)
    conditions.push(eq(schema.refunds.providerReference, event.providerRefundId));
  if (attemptId)
    conditions.push(
      and(
        eq(schema.refunds.paymentAttemptId, attemptId),
        sql`${schema.refunds.status} in ('approved','submitted','pending','settled','failed')`,
      ),
    );
  if (conditions.length === 0) return null;
  const rows = await tx
    .select()
    .from(schema.refunds)
    .where(or(...conditions))
    .orderBy(sql`${schema.refunds.createdAt} desc`)
    .limit(2);
  if (event.providerRefundId) {
    const exact = rows.find((r) => r.providerReference === event.providerRefundId);
    if (exact) return exact;
  }
  return rows[0] ?? null;
}

export async function applyProviderRefundStatus(
  rt: FinanceRuntime,
  input: {
    event: ParsedProviderEvent;
    providerStatus: ProviderRefundStatus;
    targetStatus: RefundState;
    correlationId?: string;
  },
): Promise<RefundRow | null> {
  const system = systemFinanceActor(input.correlationId);
  const refund = await withActor(rt.db, system.ctx, async (tx) => {
    let attemptId: string | null = null;
    if (input.event.reference) {
      const [attempt] = await tx
        .select({ id: schema.paymentAttempts.id })
        .from(schema.paymentAttempts)
        .where(eq(schema.paymentAttempts.reference, input.event.reference));
      attemptId = attempt?.id ?? null;
    }
    return findRefundForEvent(tx, input.event, attemptId);
  });
  if (!refund) return null;
  if (input.event.amountKobo !== null && input.event.amountKobo !== refund.amountKobo) {
    await withActor(rt.db, system.ctx, (tx) =>
      addReconciliationException(
        tx,
        {
          code: 'refund_amount_mismatch',
          message: `refund ${refund.id}: provider reports ${input.event.amountKobo} kobo, record is ${refund.amountKobo}`,
          entityType: 'refund',
          entityId: refund.id,
        },
        rt.now(),
      ),
    );
    return refund;
  }
  return applyProviderRefundOutcome(rt, refund.id, input.providerStatus, {
    correlationId: input.correlationId,
    via: 'webhook',
  });
}

/** Reconciliation: poll the provider for refunds still in flight. */
export async function pollPendingRefunds(
  rt: FinanceRuntime,
  options: { correlationId?: string } = {},
): Promise<number> {
  const system = systemFinanceActor(options.correlationId);
  const pending = await withActor(rt.db, system.ctx, (tx) =>
    tx
      .select()
      .from(schema.refunds)
      .where(
        and(
          sql`${schema.refunds.status} in ('submitted','pending')`,
          sql`${schema.refunds.providerReference} is not null`,
        ),
      ),
  );
  let touched = 0;
  for (const refund of pending) {
    const [attempt] = await withActor(rt.db, system.ctx, (tx) =>
      tx
        .select()
        .from(schema.paymentAttempts)
        .where(eq(schema.paymentAttempts.id, refund.paymentAttemptId)),
    );
    if (!attempt) continue;
    try {
      const resolved = await providerForAttempt(rt, attempt);
      const result = await resolved.provider.getRefund(refund.providerReference!);
      await applyProviderRefundOutcome(rt, refund.id, result.status, {
        correlationId: options.correlationId,
        via: 'poll',
      });
      touched += 1;
    } catch {
      // Provider unreachable: the next run retries; nothing is credited meanwhile.
    }
  }
  return touched;
}
