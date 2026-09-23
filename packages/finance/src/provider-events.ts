import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { ApiError } from '@simplexd/contracts';
import { enqueueJob, schema, withActor } from '@simplexd/db';
import {
  ProviderError,
  deriveDedupeKey,
  planWebhookActions,
  sanitizeHeaders,
  type ExistingRecords,
  type ParsedProviderEvent,
  type WebhookAction,
} from '@simplexd/integrations/payments';
import { systemFinanceActor } from './actor';
import { recordAudit } from './audit';
import { openChargebackFromEvent, resolveChargebackFromEvent } from './chargebacks';
import { verifyAttemptAsSystem } from './payment-attempts';
import { addReconciliationException } from './reconciliation-exceptions';
import { applyProviderRefundStatus, findRefundForEvent } from './refunds';
import { requireProvider, type FinanceRuntime } from './runtime';
import { attemptDedupeKey } from './settlement';

export const PROCESS_PROVIDER_EVENT_JOB = 'payments.process_provider_event';

export interface WebhookReceipt {
  status: 200 | 401;
  received: boolean;
  duplicate: boolean;
  providerEventId: string | null;
  jobId: string | null;
}

/**
 * Durable, deduplicated intake for Paystack webhooks (build brief §12):
 * verifies the HMAC-SHA512 signature over the exact raw body with the
 * configured secret (the dev adapter's secret in development), persists the
 * `provider_events` row (invalid signature → `signature_valid=false`, 401 and
 * no job), acknowledges duplicates with 200 and no new job, and enqueues
 * `payments.process_provider_event` in the same transaction otherwise.
 */
export async function receiveProviderWebhook(
  rt: FinanceRuntime,
  input: {
    rawBody: Buffer | string;
    signatureHeader: string | null | undefined;
    headers: Record<string, string | string[] | undefined>;
    correlationId?: string;
  },
): Promise<WebhookReceipt> {
  const rawText = typeof input.rawBody === 'string' ? input.rawBody : input.rawBody.toString('utf8');
  const system = systemFinanceActor(input.correlationId);
  const resolved = await rt.resolveProvider(rt.defaultEnvironment);
  const headersSanitized = sanitizeHeaders(input.headers);
  const now = rt.now();
  const signatureValid = resolved ? resolved.provider.verifyWebhookSignature(input.rawBody, input.signatureHeader) : false;

  if (!resolved || !signatureValid) {
    const bodyHash = createHash('sha256').update(rawText).digest('hex').slice(0, 24);
    const eventType = guessEventType(rawText);
    await withActor(rt.db, system.ctx, async (tx) => {
      await tx.insert(schema.providerEvents).values({
        provider: resolved?.kind ?? 'paystack',
        environment: resolved?.environment ?? rt.defaultEnvironment,
        dedupeKey: `invalid:${now.getTime()}:${bodyHash}`,
        providerEventId: null,
        eventType,
        reference: null,
        signatureValid: false,
        rawBody: rawText,
        headersSanitized,
        processingStatus: 'ignored',
        processedAt: now,
        processingError: resolved ? 'invalid signature' : 'no payment provider configured',
      });
      await recordAudit(tx, system, {
        action: 'provider_event.rejected',
        entityType: 'provider_event',
        after: { eventType, reason: resolved ? 'invalid_signature' : 'provider_not_configured' },
        actorType: 'webhook',
      });
    });
    return { status: 401, received: false, duplicate: false, providerEventId: null, jobId: null };
  }

  let event: ParsedProviderEvent;
  try {
    event = resolved.provider.parseWebhookEvent(input.rawBody);
  } catch (err) {
    if (err instanceof ProviderError) {
      throw new ApiError('validation_failed', err.message);
    }
    throw err;
  }
  const dedupeKey = deriveDedupeKey(event);
  return withActor(rt.db, system.ctx, async (tx) => {
    const inserted = await tx
      .insert(schema.providerEvents)
      .values({
        provider: event.provider,
        environment: event.environment === 'unknown' ? resolved.environment : event.environment,
        dedupeKey,
        providerEventId: event.providerEventId,
        eventType: event.eventType,
        reference: event.reference,
        signatureValid: true,
        rawBody: rawText,
        headersSanitized,
        processingStatus: 'queued',
      })
      .onConflictDoNothing({ target: schema.providerEvents.dedupeKey })
      .returning({ id: schema.providerEvents.id });
    const row = inserted[0];
    if (!row) {
      const [existing] = await tx
        .select({ id: schema.providerEvents.id })
        .from(schema.providerEvents)
        .where(eq(schema.providerEvents.dedupeKey, dedupeKey));
      return { status: 200, received: true, duplicate: true, providerEventId: existing?.id ?? null, jobId: null };
    }
    const job = await enqueueJob(tx, {
      type: PROCESS_PROVIDER_EVENT_JOB,
      queue: 'payments',
      payload: { providerEventId: row.id, eventType: event.eventType, reference: event.reference },
      dedupeKey: `provider_event:${row.id}`,
      correlationId: input.correlationId ?? null,
      maxAttempts: 10,
    });
    await recordAudit(tx, system, {
      action: 'provider_event.received',
      entityType: 'provider_event',
      entityId: row.id,
      after: { eventType: event.eventType, reference: event.reference, environment: event.environment, jobId: job.id },
      actorType: 'webhook',
    });
    return { status: 200, received: true, duplicate: false, providerEventId: row.id, jobId: job.id };
  });
}

function guessEventType(rawText: string): string {
  try {
    const parsed = JSON.parse(rawText) as { event?: unknown };
    return typeof parsed.event === 'string' ? parsed.event.slice(0, 100) : 'unknown';
  } catch {
    return 'unparseable';
  }
}

export interface ProcessedEvent {
  providerEventId: string;
  actions: Array<{ kind: WebhookAction['kind']; result: string }>;
}

/**
 * Worker side: loads the persisted event, re-parses the stored raw body,
 * gathers the current state of the records it references and executes the
 * planned actions. `charge.success` never allocates directly: it verifies
 * with the provider and settles through the shared settlement path.
 */
export async function processProviderEvent(
  rt: FinanceRuntime,
  providerEventId: string,
  options: { correlationId?: string } = {},
): Promise<ProcessedEvent> {
  const system = systemFinanceActor(options.correlationId);
  const stored = await withActor(rt.db, system.ctx, async (tx) => {
    const [row] = await tx.select().from(schema.providerEvents).where(eq(schema.providerEvents.id, providerEventId));
    if (!row) throw new ApiError('not_found', 'provider event not found');
    return row;
  });
  if (!stored.signatureValid) {
    return { providerEventId, actions: [{ kind: 'ignore', result: 'invalid signature; never processed' }] };
  }
  if (stored.processingStatus === 'processed') {
    return { providerEventId, actions: [{ kind: 'ignore', result: 'already processed' }] };
  }
  const resolved = await requireProvider(rt, stored.environment === 'live' ? 'live' : 'test');
  const event = resolved.provider.parseWebhookEvent(stored.rawBody);
  const results: ProcessedEvent['actions'] = [];
  const markProcessed = async (error?: string) => {
    await withActor(rt.db, system.ctx, (tx) =>
      tx
        .update(schema.providerEvents)
        .set({
          processingStatus: error ? 'failed' : 'processed',
          processedAt: rt.now(),
          processingError: error ? error.slice(0, 1000) : null,
          attempts: stored.attempts + 1,
        })
        .where(eq(schema.providerEvents.id, providerEventId)),
    );
  };

  if (event.environment !== 'unknown' && event.environment !== resolved.environment) {
    await withActor(rt.db, system.ctx, (tx) =>
      addReconciliationException(
        tx,
        { code: 'environment_mismatch', message: `${event.eventType} for ${event.environment} received on the ${resolved.environment} endpoint`, entityType: 'provider_event', entityId: providerEventId },
        rt.now(),
      ),
    );
    await markProcessed();
    return { providerEventId, actions: [{ kind: 'flag_for_reconciliation', result: 'environment mismatch' }] };
  }

  const existing = await loadExistingRecords(rt, event);
  const actions = planWebhookActions(event, existing);
  try {
    for (const action of actions) {
      results.push({ kind: action.kind, result: await executeAction(rt, event, action, providerEventId, options.correlationId) });
    }
    await markProcessed();
  } catch (err) {
    await markProcessed(err instanceof Error ? err.message : String(err));
    throw err;
  }
  return { providerEventId, actions: results };
}

async function loadExistingRecords(rt: FinanceRuntime, event: ParsedProviderEvent): Promise<ExistingRecords> {
  const system = systemFinanceActor();
  return withActor(rt.db, system.ctx, async (tx) => {
    let attemptStatus: ExistingRecords['attemptStatus'] = null;
    let alreadyAllocated = false;
    let attemptId: string | null = null;
    if (event.reference) {
      const [attempt] = await tx
        .select({ id: schema.paymentAttempts.id, status: schema.paymentAttempts.status })
        .from(schema.paymentAttempts)
        .where(eq(schema.paymentAttempts.reference, event.reference));
      if (attempt) {
        attemptId = attempt.id;
        attemptStatus = attempt.status;
        const [alloc] = await tx.select({ id: schema.allocations.id }).from(schema.allocations).where(eq(schema.allocations.dedupeKey, attemptDedupeKey(attempt.id)));
        alreadyAllocated = Boolean(alloc);
      }
    }
    const refund = event.eventType.startsWith('refund.') ? await findRefundForEvent(tx, event, attemptId) : null;
    let chargebackStatus: ExistingRecords['chargebackStatus'] = null;
    if (attemptId && event.eventType.startsWith('charge.dispute.')) {
      const [cb] = await tx.select({ status: schema.chargebacks.status }).from(schema.chargebacks).where(eq(schema.chargebacks.paymentAttemptId, attemptId));
      chargebackStatus = cb?.status ?? null;
    }
    return { attemptStatus, alreadyAllocated, refundStatus: refund?.status ?? null, chargebackStatus };
  });
}

async function executeAction(
  rt: FinanceRuntime,
  event: ParsedProviderEvent,
  action: WebhookAction,
  providerEventId: string,
  correlationId?: string,
): Promise<string> {
  const system = systemFinanceActor(correlationId);
  switch (action.kind) {
    case 'verify_and_settle': {
      const result = await verifyAttemptAsSystem(rt, action.reference, { source: 'webhook', correlationId });
      return `${result.outcome.decision}${result.receiptNumber ? ` receipt ${result.receiptNumber}` : ''}`;
    }
    case 'update_refund': {
      const updated = await applyProviderRefundStatus(rt, {
        event,
        providerStatus: action.providerStatus,
        targetStatus: action.targetStatus,
        correlationId,
      });
      return updated ? `refund ${updated.id} → ${updated.status}` : 'refund not found';
    }
    case 'open_chargeback': {
      const cb = await openChargebackFromEvent(rt, { event, action, correlationId });
      return cb ? `chargeback ${cb.id} opened` : 'chargeback not opened';
    }
    case 'chargeback_reminder': {
      await withActor(rt.db, system.ctx, (tx) =>
        addReconciliationException(
          tx,
          { code: 'chargeback_evidence_due', message: `${action.reference}: evidence due ${action.evidenceDueAt ?? 'soon'}`, entityType: 'provider_event', entityId: providerEventId },
          rt.now(),
        ),
      );
      return 'reminder recorded';
    }
    case 'resolve_chargeback': {
      const cb = await resolveChargebackFromEvent(rt, { event, action, correlationId });
      return cb ? `chargeback ${cb.id} → ${cb.status}` : 'chargeback not found';
    }
    case 'flag_for_reconciliation': {
      await withActor(rt.db, system.ctx, (tx) =>
        addReconciliationException(
          tx,
          { code: 'provider_event_flagged', message: `${event.eventType}${action.reference ? ` (${action.reference})` : ''}: ${action.reason}`, entityType: 'provider_event', entityId: providerEventId },
          rt.now(),
        ),
      );
      return `flagged: ${action.reason}`;
    }
    case 'ignore':
    default:
      return `ignored: ${(action as { reason?: string }).reason ?? ''}`;
  }
}
