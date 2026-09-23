import { eq } from 'drizzle-orm';
import { schema, withActor } from '@simplexd/db';
import { chargebackLost, chargebackOpened, chargebackWon } from '@simplexd/domain/ledger';
import type { ParsedProviderEvent, WebhookAction } from '@simplexd/integrations/payments';
import { systemFinanceActor } from './actor';
import { emitEvent, recordAudit } from './audit';
import { JournalAlreadyPostedError, postJournal } from './journal';
import { addReconciliationException } from './reconciliation-exceptions';
import type { FinanceRuntime } from './runtime';

export type ChargebackRow = typeof schema.chargebacks.$inferSelect;

type OpenAction = Extract<WebhookAction, { kind: 'open_chargeback' }>;
type ResolveAction = Extract<WebhookAction, { kind: 'resolve_chargeback' }>;

/**
 * Disputes are privileged records. Opening one posts `chargebackOpened`
 * (the gateway withholds the amount) and a reconciliation task; the original
 * payment history is untouched.
 */
export async function openChargebackFromEvent(
  rt: FinanceRuntime,
  input: { event: ParsedProviderEvent; action: OpenAction; correlationId?: string },
): Promise<ChargebackRow | null> {
  const system = systemFinanceActor(input.correlationId);
  return withActor(rt.db, system.ctx, async (tx) => {
    const [attempt] = await tx
      .select()
      .from(schema.paymentAttempts)
      .where(eq(schema.paymentAttempts.reference, input.action.reference))
      .for('update');
    if (!attempt) return null;
    const [existing] = await tx
      .select()
      .from(schema.chargebacks)
      .where(eq(schema.chargebacks.paymentAttemptId, attempt.id));
    if (existing) return existing;
    const now = rt.now();
    const amountKobo = input.action.amountKobo ?? attempt.amountKobo;
    const [chargeback] = await tx
      .insert(schema.chargebacks)
      .values({
        paymentAttemptId: attempt.id,
        providerReference: input.action.providerDisputeId,
        amountKobo,
        currency: input.action.currency ?? attempt.currency,
        status: 'opened',
        evidenceDueAt: input.action.evidenceDueAt ? new Date(input.action.evidenceDueAt) : null,
        notes: `opened from ${input.event.eventType}`,
      })
      .returning();
    let journalId: string | null = null;
    try {
      journalId = (
        await postJournal(
          tx,
          chargebackOpened({
            chargeback: {
              id: chargeback!.id,
              paymentAttemptId: attempt.id,
              organizationId: attempt.organizationId,
              currency: chargeback!.currency,
              amountKobo,
            },
          }),
        )
      ).id;
      await tx
        .update(schema.chargebacks)
        .set({ journalId })
        .where(eq(schema.chargebacks.id, chargeback!.id));
    } catch (err) {
      if (!(err instanceof JournalAlreadyPostedError)) throw err;
    }
    const reconciliationId = await addReconciliationException(
      tx,
      {
        code: 'chargeback_opened',
        message: `${attempt.reference}: dispute of ${amountKobo} kobo; evidence due ${input.action.evidenceDueAt ?? 'unknown'}`,
        entityType: 'chargeback',
        entityId: chargeback!.id,
      },
      now,
    );
    await tx
      .update(schema.chargebacks)
      .set({ reconciliationTaskId: reconciliationId })
      .where(eq(schema.chargebacks.id, chargeback!.id));
    await emitEvent(tx, system, {
      eventType: 'chargeback.opened',
      aggregateType: 'chargeback',
      aggregateId: chargeback!.id,
      organizationId: attempt.organizationId,
      payload: {
        chargebackId: chargeback!.id,
        paymentAttemptId: attempt.id,
        invoiceId: attempt.invoiceId,
        amountKobo,
        evidenceDueAt: input.action.evidenceDueAt,
      },
    });
    await recordAudit(tx, system, {
      action: 'chargeback.opened',
      entityType: 'chargeback',
      entityId: chargeback!.id,
      organizationId: attempt.organizationId,
      after: { paymentAttemptId: attempt.id, amountKobo, journalId },
      actorType: 'webhook',
    });
    return chargeback!;
  });
}

/** Won: reversal of the opening entry. Lost: loss expense. Unknown: finance confirms before any posting. */
export async function resolveChargebackFromEvent(
  rt: FinanceRuntime,
  input: { event: ParsedProviderEvent; action: ResolveAction; correlationId?: string },
): Promise<ChargebackRow | null> {
  const system = systemFinanceActor(input.correlationId);
  return withActor(rt.db, system.ctx, async (tx) => {
    const [attempt] = await tx
      .select()
      .from(schema.paymentAttempts)
      .where(eq(schema.paymentAttempts.reference, input.action.reference));
    if (!attempt) return null;
    const [chargeback] = await tx
      .select()
      .from(schema.chargebacks)
      .where(eq(schema.chargebacks.paymentAttemptId, attempt.id))
      .for('update');
    if (!chargeback) return null;
    if (['won', 'lost', 'closed'].includes(chargeback.status)) return chargeback;
    const now = rt.now();
    if (input.action.resolution === 'unknown') {
      await addReconciliationException(
        tx,
        {
          code: 'chargeback_resolution_unknown',
          message: `${attempt.reference}: dispute resolved with an unrecognised outcome; finance must confirm won/lost`,
          entityType: 'chargeback',
          entityId: chargeback.id,
        },
        now,
      );
      const [updated] = await tx
        .update(schema.chargebacks)
        .set({
          status: 'evidence_submitted',
          notes: `${chargeback.notes ?? ''}\nresolution reported as unknown`.trim(),
        })
        .where(eq(schema.chargebacks.id, chargeback.id))
        .returning();
      return updated!;
    }
    const chargebackInput = {
      chargeback: {
        id: chargeback.id,
        paymentAttemptId: attempt.id,
        organizationId: attempt.organizationId,
        currency: chargeback.currency,
        amountKobo: chargeback.amountKobo,
      },
    };
    const draft =
      input.action.resolution === 'won'
        ? chargebackWon(chargebackInput)
        : chargebackLost(chargebackInput);
    let journalId: string | null = null;
    try {
      journalId = (await postJournal(tx, draft)).id;
    } catch (err) {
      if (!(err instanceof JournalAlreadyPostedError)) throw err;
    }
    const [updated] = await tx
      .update(schema.chargebacks)
      .set({ status: input.action.resolution, resolvedAt: now })
      .where(eq(schema.chargebacks.id, chargeback.id))
      .returning();
    if (input.action.resolution === 'lost') {
      await addReconciliationException(
        tx,
        {
          code: 'chargeback_lost',
          message: `${attempt.reference}: dispute lost; review invoice ${attempt.invoiceId} for a credit note or reopening`,
          entityType: 'chargeback',
          entityId: chargeback.id,
        },
        now,
      );
    }
    await emitEvent(tx, system, {
      eventType: `chargeback.${input.action.resolution}`,
      aggregateType: 'chargeback',
      aggregateId: chargeback.id,
      organizationId: attempt.organizationId,
      payload: {
        chargebackId: chargeback.id,
        paymentAttemptId: attempt.id,
        invoiceId: attempt.invoiceId,
        amountKobo: chargeback.amountKobo,
      },
    });
    await recordAudit(tx, system, {
      action: `chargeback.${input.action.resolution}`,
      entityType: 'chargeback',
      entityId: chargeback.id,
      organizationId: attempt.organizationId,
      before: { status: chargeback.status },
      after: { status: input.action.resolution, journalId },
      actorType: 'webhook',
    });
    return updated!;
  });
}
